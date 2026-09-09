/**
 * brisk.news, all of it that can be read.
 *
 * brisk.news is ours too, and like nichedb it has already done the fetching and
 * parsing: a `poll-feeds` daemon reads ~33,000 independent feeds -- the Kagi
 * small-web catalogue plus a curated set -- alongside a mainstream wire, and
 * publishes the merged result through a keyless search API at `/api/news`. So
 * this adapter is a projection of that, not a thirteenth feed parser.
 *
 * WHAT IT CARRIES
 *
 * `/api/news` merges three corpora and labels each row with `source_type`. Two
 * of them are taken:
 *
 * - `rss` -- the small-web firehose. Independent blogs, one writer each.
 *            Reachable only through the uncategorised feed and through `search`;
 *            a `category=` query never returns one. It becomes the `independent`
 *            desk, because nothing else here carries the small web and a blog is
 *            not a newsroom.
 * - `api` -- a mainstream wire, filterable by brisk's own ten categories, which
 *            are mapped onto this brand's desks below. It overlaps nichedb in
 *            places and covers a great deal that nichedb does not (measured
 *            2026-09-09: 6,778 general, 1,541 tech, 1,268 entertainment, 1,112
 *            business, 636 politics, 607 sports, 335 science, 169 health, 115
 *            travel, 64 food), and `ingest` deduplicates on `provider_key`.
 *
 * The third, `google`, is dropped -- and that is a defect, not a preference.
 * Its URLs are `news.google.com/rss/articles/...` stubs, and a request for one
 * 302s straight back to news.google.com rather than to any publisher (checked
 * live, 2026-09-09). Every one of them would be a dead link on a page whose
 * whole promise is showing you who reported it.
 *
 * WHAT IT COSTS THAT NICHEDB DOES NOT
 *
 * This adapter files under desks nichedb also writes, which the freshness gate
 * could not express until `lastSyncedAtForProvider` existed: `ingest` stamps its
 * clock on every collection an adapter wrote, so a gate that asks by `sport`
 * cannot tell whose pass did the stamping, and the adapter registered second
 * would read the first one's clock and skip on every tick forever. See the note
 * in `syncBrandCatalog`.
 */

import { decodeEntities } from './entities.js';
import { getJson } from './http.js';
import { boundedKeyFor, keyFor, slugify } from './slug.js';

const BASE = 'https://brisk.news/api/news';
const PROVIDER = 'brisk';

/**
 * brisk's own category vocabulary, mapped onto this brand's desks.
 *
 * The keys are what `category=` accepts; the values are `sport` column values.
 * `general` is brisk's unfiled majority and lands on `world`, which is where
 * nichedb already puts a wire story that names no desk. `entertainment`, `food`
 * and `travel` have no counterpart here, so they arrive as desks of their own
 * rather than being folded into a section that would misfile them.
 */
export const CATEGORY_SECTION = {
  general: 'world',
  politics: 'politics',
  business: 'business',
  tech: 'technology',
  science: 'science',
  health: 'health',
  sports: 'sport',
  entertainment: 'entertainment',
  food: 'food',
  travel: 'travel',
};

/**
 * The small web's own desk. Not one of brisk's categories -- an `rss` row is
 * never returned by a `category=` query -- so it is named here.
 */
export const INDEPENDENT = 'independent';

/**
 * Every desk this adapter can write. `brand.categories` must contain all of
 * them or a story lands on a section the site does not offer.
 */
export const SECTIONS = [...new Set([...Object.values(CATEGORY_SECTION), INDEPENDENT])];

/** Names for the desks this adapter introduces; the rest nichedb already names. */
export const SECTION_NAMES = {
  world: 'World',
  politics: 'Politics',
  business: 'Business',
  technology: 'Technology',
  science: 'Science',
  health: 'Health',
  sport: 'Sport',
  entertainment: 'Entertainment',
  food: 'Food',
  travel: 'Travel',
  independent: 'Independent',
};

/**
 * Where each desk sits. These have to agree with nichedb's numbers for the desks
 * both write, or the same section sorts differently depending on which adapter
 * happened to create the row.
 */
const SECTION_PRIORITY = { world: 10, politics: 30, business: 40 };
const DEFAULT_PRIORITY = 100;

/** The small web sits below the newsrooms: it is a supplement, not the front page. */
const INDEPENDENT_PRIORITY = 200;

const priorityOf = (section) =>
  section === INDEPENDENT ? INDEPENDENT_PRIORITY : (SECTION_PRIORITY[section] ?? DEFAULT_PRIORITY);

/**
 * brisk caps a response at 50 rows however large a `limit` you ask for, and the
 * merge dilutes the small web as the page grows -- measured 2026-09-09, a
 * `limit=30` page came back roughly a third `rss` while `limit=100` (truncated
 * to 50) came back one seventh. Asking for less per page yields more of what we
 * are actually here for.
 */
const PAGE = 30;

/**
 * URLs that are a feed rather than something to read.
 *
 * The corpus is built from feed documents, and a few of them advertise their own
 * comment feed as an entry: Blogger's `/feeds/<id>/comments/default` arrives with
 * a real post title attached to a raw XML endpoint. Publishing that as a story
 * gives a reader a headline that opens a wall of markup.
 */
const FEED_URL = /\/comments\/|\/feeds?\/|\.(?:xml|rss|atom)(?:$|\?)/i;

/**
 * brisk renders a placeholder card image on demand at its own `/api/screenshot`.
 * That is the right call on brisk, where it is one page of cards; carrying it
 * here would point every story card on this site at another site's renderer and
 * make the front page's load time somebody else's problem. A story with no real
 * image gets none.
 */
const SCREENSHOT = /^https?:\/\/[^/]*brisk\.news\/api\/screenshot/i;

/**
 * The publisher, as {key, name}, from the delivery host.
 *
 * `source` is already a bare host on every `rss` row. `www.` is stripped because
 * the same blog arrives both ways and would otherwise be two outlets a reader
 * has to follow separately.
 */
export function outletOf(item) {
  const raw = typeof item?.source === 'string' ? item.source.trim().toLowerCase() : '';
  if (!raw) return null;
  const host = raw.replace(/^www\./, '');
  // A "host" with a space or a slash in it is a feed title that leaked into the
  // column, not a domain, and it would slugify into something unrecognisable.
  if (!host || /[\s/]/.test(host) || !host.includes('.')) return null;
  return { key: host, name: host };
}

/**
 * The URL an outlet lives at.
 *
 * Discriminated, deliberately, unlike nichedb's plain slug. `teams.slug` is NOT
 * NULL UNIQUE while `upsertTeams` conflicts on `(provider, provider_key)`, so a
 * brisk outlet that slugified to the same string as an existing nichedb outlet
 * would raise a unique violation and abort the WHOLE batch -- losing every good
 * row in the pass, not just the clashing one. Both providers identify a
 * publisher by bare host, so that collision is not hypothetical. Every other
 * adapter here already discriminates its subject slugs (`slugify(name, id)`) for
 * exactly this reason; brisk has no upstream id, so the provider name is the
 * discriminator, which no nichedb outlet can produce.
 */
export function outletSlug(outlet) {
  return slugify(outlet.name, PROVIDER);
}

/** Fetch one page of the search API. `search` empty means the plain firehose. */
async function page({ search = '', category = '', pageNo = 1 } = {}) {
  const url =
    `${BASE}?limit=${PAGE}&page=${pageNo}` +
    (search ? `&search=${encodeURIComponent(search)}` : '') +
    (category ? `&category=${encodeURIComponent(category)}` : '');
  const res = await getJson(url, { timeoutMs: 30_000 });
  return res?.articles ?? [];
}

/**
 * Turn brisk articles into catalogue rows, accumulating into the maps.
 *
 * Exported so the mapping can be tested without the network -- the filtering is
 * the only part of this adapter with any decisions in it.
 */
export function collect(items, { desks, outlets, events, seen = new Set(), section } = {}) {
  for (const it of items ?? []) {
    /*
     * Which desk this row belongs on, decided by where it came from rather than
     * by reading the text. An `rss` row is the small web wherever it surfaced --
     * the firehose or a `search` -- and a wire row belongs to the category that
     * was asked for. A wire row with nothing to attribute it to (the firehose,
     * a bare search) is skipped rather than guessed at: the `categories` field
     * on the row itself is empty about as often as not.
     */
    const desk =
      it?.source_type === 'rss'
        ? INDEPENDENT
        : it?.source_type === 'api'
          ? (section ?? null)
          : null;
    // `google` rows land here as null. They are dead links -- see the top of
    // this file -- and there is nothing to file.
    if (!desk) continue;
    if (!it.title || !it.url) continue;
    if (FEED_URL.test(it.url)) continue;

    // Pages are assembled per request out of a merge, so the same story can turn
    // up on two of them. Deduping here rather than relying on the writer keeps
    // one pass's numbers honest.
    if (seen.has(it.url)) continue;

    // A story with no timestamp cannot be placed on a day, and the home page is
    // a day. Skipped rather than dated to "now", which would make a backfill
    // read as breaking news.
    const publishedAt = it.publishedAt ? new Date(it.publishedAt) : null;
    if (!publishedAt || Number.isNaN(publishedAt.getTime())) continue;

    const outlet = outletOf(it);
    if (!outlet) continue;

    // A title that was nothing but entities decodes to nothing, and a card with
    // no headline is not a story.
    const title = decodeEntities(it.title);
    if (!title) continue;

    seen.add(it.url);

    const deskKey = keyFor(PROVIDER, 'desk', desk);
    if (!desks.has(deskKey)) {
      desks.set(deskKey, {
        provider: PROVIDER,
        providerKey: deskKey,
        category: desk,
        /*
         * Discriminated for the same reason the outlet slug is. `leagues.slug`
         * is UNIQUE as well, and nichedb already owns `world-news` and the rest
         * of these names -- an undiscriminated slug here would abort the pass
         * before a single story was written.
         */
        slug: slugify(`${desk}-news`, PROVIDER),
        name: SECTION_NAMES[desk],
        priority: priorityOf(desk),
      });
    }

    const outletKey = keyFor(PROVIDER, 'outlet', outlet.key);
    if (!outlets.has(outletKey)) {
      outlets.set(outletKey, {
        provider: PROVIDER,
        providerKey: outletKey,
        category: desk,
        kind: 'outlet',
        slug: outletSlug(outlet),
        name: outlet.name,
        displayName: outlet.name,
        description: null,
        imageUrl: null,
        url: null,
        genreKeys: [],
      });
    }
    // One publisher files to several desks -- a wire outlet across the
    // categories it covers -- so its set accumulates rather than being fixed by
    // whichever desk happened to see it first.
    const outletRow = outlets.get(outletKey);
    if (!outletRow.genreKeys.includes(deskKey)) outletRow.genreKeys.push(deskKey);

    events.push({
      provider: PROVIDER,
      // The article URL is brisk's own identity for an rss row (its `uuid` is
      // the URL), and it survives a re-poll where a row id might not.
      providerKey: boundedKeyFor([PROVIDER, 'story', it.url]),
      category: desk,
      subjectKey: outletKey,
      kind: 'story',
      startsAt: publishedAt,
      timeKnown: true,
      precision: 'minute',
      // Published, not scheduled -- the same tense problem nichedb documents.
      state: 'out',
      name: title,
      shortName: null,
      summary: decodeEntities(it.description ?? it.snippet ?? null),
      // The publisher's own image, or none. Never brisk's on-demand screenshot.
      imageUrl: it.imageUrl && !SCREENSHOT.test(it.imageUrl) ? it.imageUrl : null,
      // The publisher, not brisk's `shortUrl` redirector: this brand's promise is
      // that you can see who reported it, and a shortener hides that in the
      // status bar of every link on the page.
      url: it.url,
      venue: null,
      venueRegion: null,
      season: null,
      number: null,
      runtimeMin: null,
    });
  }
}

/**
 * Recent stories from every corpus brisk carries, newest first.
 *
 * Two passes, because the two corpora are reachable by different doors. The
 * uncategorised firehose is the only place `rss` rows surface in bulk, and a
 * `category=` query is the only way to attribute a wire row to a desk -- asking
 * one endpoint both questions would return the wire with no desk and the small
 * web not at all.
 *
 * Sequential, and against one host: brisk is ours but it is still an HTTP API
 * with a database behind it, and `getJson` already paces per host.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxPages] Firehose pages. Roughly a third of each is
 *   small web, so the default trades 20 requests for ~200 independent stories.
 * @param {number} [opts.categoryPages] Pages per category, over ten categories.
 * @param {string[]} [opts.terms] Optional subjects to deepen. `search=` is far
 *   denser in small-web rows than the firehose (measured: 19 of 20 for `rust`,
 *   3 of 3 for `gardening`). Empty by default -- a hardcoded term list would be
 *   an editorial line nobody chose, where "newest first" is one this brand
 *   already states on the page.
 */
export async function fetchAll({ maxPages = 20, categoryPages = 3, terms = [] } = {}) {
  const desks = new Map();
  const outlets = new Map();
  const events = [];
  const seen = new Set();
  const acc = { desks, outlets, events, seen };

  // The small web. `section` is unset because an rss row files itself.
  for (let p = 1; p <= maxPages; p++) {
    const items = await page({ pageNo: p });
    if (items.length === 0) break;
    collect(items, acc);
    if (items.length < PAGE) break;
  }

  // The wire, one desk at a time, because the desk is the question being asked.
  for (const [category, section] of Object.entries(CATEGORY_SECTION)) {
    for (let p = 1; p <= categoryPages; p++) {
      const items = await page({ category, pageNo: p });
      if (items.length === 0) break;
      collect(items, { ...acc, section });
      if (items.length < PAGE) break;
    }
  }

  for (const term of terms) {
    const items = await page({ search: term });
    collect(items, acc);
  }

  return { genres: [...desks.values()], subjects: [...outlets.values()], events };
}

/*
 * `category` is what `syncBrandCatalog` used to gate on. It now gates by
 * provider -- these desks are shared with nichedb, which the old query could not
 * express -- but the field is still read for the per-adapter branches there, so
 * it names the desk only this adapter writes.
 */
export const adapter = { name: PROVIDER, category: INDEPENDENT, fetchAll };
