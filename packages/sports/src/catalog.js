/**
 * Non-sports providers, and how their output lands in the sports schema.
 *
 * The interesting thing here is that no schema change was needed. `leagues` is a
 * collection of things, `teams` are the participants, `team_leagues` is already
 * many-to-many, and `home_team_id`/`away_team_id` are already nullable because a
 * race and a fight card have no two sides. A television series inside a genre is
 * that same shape wearing different words -- so a genre becomes a league row, a
 * show becomes a team row, and an episode becomes an event with one side.
 *
 * The two genuinely new facts are `time_known` and `precision`, added in 0017,
 * because a release has a date and no hour where a fixture always has a kickoff.
 *
 * Which of these run is a brand decision (packages/config/src/brands.js), not a
 * code one: the sports brand runs espn, the genre brand runs these five.
 */

import * as q from '@tipoff/db/queries';
import * as anilist from './anilist.js';
import * as musicbrainz from './musicbrainz.js';
import * as nichedb from './nichedb.js';
import { slugify } from './slug.js';
import * as spacedevs from './spacedevs.js';
import * as tmdb from './tmdb.js';
import * as tvmaze from './tvmaze.js';

/**
 * Each adapter with the cadence its provider will actually tolerate.
 *
 * `minIntervalMinutes` is checked against the last COMPLETED pass recorded in the
 * database, never against a job timer -- a repeatable's timer resets on every
 * deploy, so on a busy day a timed sweep can be pushed forward forever and never
 * run at all. That lesson is already written into this repo's queue; this obeys it.
 *
 * Order matters. Spaceflight is two requests and five seconds but gets FIFTEEN
 * requests an hour for the whole deployment; music is one request per second
 * against an upstream that times out. Putting music first starved spaceflight for
 * twenty minutes on a real sync, so the cheap tightly-budgeted provider goes
 * first.
 */
export const CATALOG_ADAPTERS = [
  { name: 'tvmaze', category: 'tv', module: tvmaze, minIntervalMinutes: 180 },
  { name: 'anilist', category: 'anime', module: anilist, minIntervalMinutes: 360 },
  { name: 'tmdb', category: 'film', module: tmdb, minIntervalMinutes: 720 },
  { name: 'spacedevs', category: 'space', module: spacedevs, minIntervalMinutes: 60 },
  { name: 'musicbrainz', category: 'music', module: musicbrainz, minIntervalMinutes: 720 },
  /*
   * Ours, and it answers in milliseconds, so the interval is about how often
   * news is worth re-reading rather than what an upstream will tolerate.
   *
   * It is the only news adapter here, and deliberately so: the two directories
   * this brand also reads are sources INSIDE that collection now, which is where
   * the deduplication lives. Reading them here as well produced one desk row and
   * one outlet row per provider for the same desk and the same publisher.
   */
  { name: 'nichedb', category: 'world', module: nichedb, minIntervalMinutes: 20 },
];

/** A provider's "upcoming" is this schema's "pre". */
const stateOf = (s) => (s === 'out' || s === 'post' ? 'post' : 'pre');

/**
 * Write one adapter's output, resolving its provider keys to row ids as it goes.
 *
 * Order is forced by the foreign keys: collections, then participants, then the
 * membership edges, then the events. Each step is a bulk upsert, so a partial
 * failure leaves the catalogue a pass out of date rather than inconsistent.
 */
export async function ingest(result, { log = console.log, name = 'catalog' } = {}) {
  const genreIds = new Map();
  for (const g of result.genres ?? []) {
    // upsertLeague takes one row and returns it, which is fine at this scale:
    // a genre catalogue has tens of collections, not hundreds.
    const row = await q.upsertLeague({
      provider: g.provider,
      provider_key: g.providerKey,
      // The category IS the sport column. Renaming it would have been the one
      // change that made every upstream merge conflict forever.
      sport: g.category,
      slug: g.slug,
      name: g.name,
      priority: g.priority ?? 100,
    });
    genreIds.set(g.providerKey, row.id);
  }

  const subjects = (result.subjects ?? []).filter((s) => s.genreKeys?.length);
  const subjectRows = subjects.map((s) => ({
    provider: s.provider,
    provider_key: s.providerKey,
    // A subject belongs to several genres; league_id is the legacy single FK and
    // team_leagues is the real answer, so this is just the first for display.
    league_id: genreIds.get(s.genreKeys[0]) ?? null,
    slug: s.slug,
    name: s.name,
    display_name: s.displayName ?? s.name,
    logo_url: s.imageUrl ?? null,
  }));

  /*
   * Give up a slug somebody else already holds.
   *
   * An adapter can only see the batch it is building, so it can keep its own
   * rows from colliding and nothing more. `teams.slug` is globally unique, and
   * `upsertTeams` conflicts on (provider, provider_key) -- so a row whose slug
   * belongs to a different key is an INSERT against a unique index, and it
   * aborts the entire pass rather than the one row.
   *
   * That stayed theoretical while each adapter owned a namespace. It became a
   * hard failure when the news collection upstream grew a newsroom directory
   * that supplies a masthead: a feed keyed `bbc-co-uk-2` arrives named "BBC
   * News", slugs to `bbc-news`, and the row keyed `bbci` has held that since the
   * first sync. Every pass failed with `duplicate key value violates unique
   * constraint "teams_slug_key"` and the newest desks stayed empty.
   *
   * The incumbent keeps the readable slug -- it is in somebody's bookmarks and
   * possibly in their follows -- and the newcomer takes the discriminated form
   * every other adapter here already uses. Derived from the provider key rather
   * than a counter, so a re-run produces the same slug rather than drifting.
   */
  const owners = await q.teamSlugOwners(subjectRows.map((r) => r.slug));
  let reslugged = 0;
  for (const row of subjectRows) {
    const held = owners.get(row.slug);
    if (!held || held === `${row.provider}:${row.provider_key}`) continue;
    row.slug = slugify(row.name, row.provider_key);
    reslugged++;
  }
  if (reslugged) log(`[sync] ${name}: ${reslugged} slug(s) already taken, discriminated`);

  const subjectIds = new Map();
  for (let i = 0; i < subjectRows.length; i += 500) {
    for (const r of await q.upsertTeams(subjectRows.slice(i, i + 500))) {
      subjectIds.set(r.provider_key, r.id);
    }
  }

  // The membership edges, one collection at a time because that is what the
  // existing helper takes.
  const byGenre = new Map();
  for (const s of subjects) {
    const sid = subjectIds.get(s.providerKey);
    if (!sid) continue;
    for (const key of s.genreKeys) {
      const gid = genreIds.get(key);
      if (!gid) continue;
      if (!byGenre.has(gid)) byGenre.set(gid, []);
      byGenre.get(gid).push(sid);
    }
  }
  for (const [gid, ids] of byGenre) await q.linkTeamsToLeague(ids, gid);

  const subjectByKey = new Map(subjects.map((s) => [s.providerKey, s]));
  const genreByKey = new Map((result.genres ?? []).map((g) => [g.providerKey, g]));
  const eventRows = [];
  let orphaned = 0;
  for (const e of result.events ?? []) {
    const subject = subjectByKey.get(e.subjectKey);
    const subjectId = subjectIds.get(e.subjectKey);
    /*
     * The collection this event actually belongs to, not merely the first one
     * its subject belongs to.
     *
     * `genreKeys[0]` is right for a subject whose collections are all one
     * category -- a show is filed under several genres and an episode belongs
     * to the show, so any of them will do. It is wrong for a subject that spans
     * categories, which is what a news outlet does: a publisher covering world
     * and US news has both desks, and every one of its stories was landing on
     * whichever came first. Live symptom after consolidating onto one provider:
     * the US and technology desks listed outlets and not one story, because
     * their publishers were filed under world first.
     *
     * Matching within the subject's own collections keeps the old answer wherever
     * they share a category -- tvmaze's genres are all `tv`, so the find returns
     * genreKeys[0] exactly as before.
     */
    const ownKey = subject?.genreKeys?.find((k) => genreByKey.get(k)?.category === e.category);
    const genreId = subject ? (genreIds.get(ownKey) ?? genreIds.get(subject.genreKeys[0])) : null;
    // league_id is NOT NULL, so an unresolved key would abort the whole batch and
    // lose a good pass over one bad row. Counted rather than swallowed.
    if (!subjectId || !genreId) {
      orphaned++;
      continue;
    }
    eventRows.push({
      provider: e.provider,
      provider_key: e.providerKey,
      league_id: genreId,
      starts_at: e.startsAt,
      state: stateOf(e.state),
      name: e.name,
      short_name: e.shortName ?? null,
      venue: e.venue ?? null,
      venue_region: e.venueRegion ?? null,
      // A story carries these and a fixture does not, so they are null for most
      // rows. They were being collected and dropped here, which is why the news
      // story page had nothing to show but the scoreboard it inherited.
      summary: e.summary ?? null,
      image_url: e.imageUrl ?? null,
      url: e.url ?? null,
      // One side, not two. The schema has always allowed this -- it is how a race
      // and a fight card are stored -- so a release needs nothing new.
      home_team_id: subjectId,
      away_team_id: null,
      time_known: e.timeKnown !== false,
      precision: e.precision ?? 'minute',
    });
  }

  /*
   * Deduplicate by provider key before writing.
   *
   * Postgres refuses an INSERT ... ON CONFLICT DO UPDATE whose own batch names the
   * same target twice, and it fails the WHOLE statement. TMDB's discover endpoint
   * is ordered by popularity and paginated, popularity shifts between requests, and
   * a film near a page boundary comes back on two consecutive pages -- which took a
   * whole category to zero events the first time this ran for real.
   */
  const unique = new Map();
  for (const r of eventRows) unique.set(r.provider_key, r);
  const deduped = [...unique.values()];

  for (let i = 0; i < deduped.length; i += 500) {
    await q.upsertEvents(deduped.slice(i, i + 500));
  }

  // Only a completed pass stamps the clock. See the note on the registry.
  for (const gid of genreIds.values()) await q.markRostersSynced(gid);

  log(
    `[sync] ${name}: ${genreIds.size} collections, ${subjectIds.size} names, ` +
      `${deduped.length} events${orphaned ? `, ${orphaned} orphaned` : ''}`,
  );
  return {
    collections: genreIds.size,
    subjects: subjectIds.size,
    events: deduped.length,
    orphaned,
  };
}
