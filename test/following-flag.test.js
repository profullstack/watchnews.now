import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * The per-viewer "you follow this fixture" flag on every schedule list.
 *
 * This exists because the bug it guards against was invisible: the event page
 * fetched follow state correctly and then never passed it to the view, so both
 * follow buttons rendered "not following" for a user who followed both teams. A
 * screenshot looked fine. Only the served markup showed it.
 *
 * Rather than restate the SQL here -- which would then be free to drift from what
 * actually ships -- the test lifts the clause out of queries.js and runs that exact
 * text. If someone edits the query, this runs the edit.
 */
let db;
let clause;
let leagueClause;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }

  const source = await readFile(
    new URL('../packages/db/src/queries.js', import.meta.url).pathname,
    'utf8',
  );
  // `vf\b`, so the narrower clause below -- which aliases `vf_l` -- is not read as
  // the start of one of these. Without the boundary a match opened inside the
  // narrow clause and ran on to the NEXT query's `) as following`, swallowing a
  // whole query and counting one extra.
  const matches = [
    ...source.matchAll(/exists \(\s*select 1 from follows vf\b[\s\S]*?\) as following/g),
  ];
  // Seven list queries carry the flag; if one loses it, that is the regression.
  // The last three are liveNow, startingSoon and recentResults, none of which is
  // about what you follow at all -- but all three render the same EventRow, and a
  // star that appears on four lists and not on the other three is the
  // inconsistency this test exists to catch.
  expect(matches.length).toBe(7);
  // Every copy must be identical, so testing one tests them all.
  const texts = new Set(matches.map((m) => m[0].replace(/\s+/g, ' ')));
  expect(texts.size).toBe(1);
  // A regex, not a string literal: the thing being replaced is a template
  // placeholder in queries.js, and writing it as text here trips the lint rule
  // that looks for accidental ones.
  clause = matches[0][0].replace(/\$\{viewerId\}/, '$1');

  /*
   * The narrower flag, and the reason it is a separate column rather than a reuse.
   *
   * `following` above answers "is this row on your list", which is true when the
   * viewer follows either side OR the section. That is the right question for the
   * star on the row and the wrong one for the row's follow button, which posts to
   * /api/unfollow: it may only read "Following" when the thing it would unfollow is
   * the section itself. The tests at the bottom hold those two apart.
   *
   * Five queries carry it -- the ones feeding a MIXED list, where consecutive rows
   * belong to different sections. A section's own page is deliberately not one of
   * them.
   */
  const leagueMatches = [
    ...source.matchAll(/exists \(\s*select 1 from follows vf_l[\s\S]*?\) as league_following/g),
  ];
  expect(leagueMatches.length).toBe(5);
  expect(new Set(leagueMatches.map((m) => m[0].replace(/\s+/g, ' '))).size).toBe(1);
  leagueClause = leagueMatches[0][0].replace(/\$\{viewerId\}/, '$1');
}, 60_000);

const one = async (sql, params) => (await db.query(sql, params)).rows[0];

/** The flag as the schedule pages compute it, for one viewer and one event. */
const followsEvent = async (userId, eventId) =>
  (
    await one(
      `select ${clause} from events e join leagues l on l.id = e.league_id where e.id = $2`,
      [userId, eventId],
    )
  ).following;

/** What the row's own follow button reads back, for one viewer and one event. */
const followsSection = async (userId, eventId) =>
  (
    await one(
      `select ${leagueClause} from events e join leagues l on l.id = e.league_id where e.id = $2`,
      [userId, eventId],
    )
  ).league_following;

describe('viewer follow flag', () => {
  let userId;
  let eventId;
  let homeId;
  let leagueId;

  beforeAll(async () => {
    leagueId = (
      await one(
        `insert into leagues (provider, provider_key, sport, slug, name)
         values ('espn','flag/test','basketball','flag-test','Flag Test') returning id`,
      )
    ).id;
    homeId = (
      await one(
        `insert into teams (provider, provider_key, league_id, slug, name, display_name)
         values ('espn','flag/test/1',$1,'flag-home','Home','Home') returning id`,
        [leagueId],
      )
    ).id;
    const awayId = (
      await one(
        `insert into teams (provider, provider_key, league_id, slug, name, display_name)
         values ('espn','flag/test/2',$1,'flag-away','Away','Away') returning id`,
        [leagueId],
      )
    ).id;
    eventId = (
      await one(
        `insert into events (provider, provider_key, league_id, starts_at, name,
                             home_team_id, away_team_id)
         values ('espn','flag/test/e1',$1, now() + interval '1 day','Away at Home',$2,$3)
         returning id`,
        [leagueId, homeId, awayId],
      )
    ).id;
    userId = (await one(`insert into users (email) values ('flag@example.com') returning id`)).id;
  });

  test('a signed-out visitor never has a followed fixture', async () => {
    expect(await followsEvent(null, eventId)).toBe(false);
  });

  test('a signed-in user who follows nothing sees no star', async () => {
    expect(await followsEvent(userId, eventId)).toBe(false);
  });

  test('following either team marks the fixture', async () => {
    await db.query(
      `insert into follows (user_id, subject_type, subject_id) values ($1,'team',$2)`,
      [userId, homeId],
    );
    expect(await followsEvent(userId, eventId)).toBe(true);
  });

  test('following the league marks it too', async () => {
    const other = (await one(`insert into users (email) values ('flag2@example.com') returning id`))
      .id;
    expect(await followsEvent(other, eventId)).toBe(false);
    await db.query(
      `insert into follows (user_id, subject_type, subject_id) values ($1,'league',$2)`,
      [other, leagueId],
    );
    expect(await followsEvent(other, eventId)).toBe(true);
  });

  /*
   * The distinction the row button rests on.
   *
   * A reader who follows one newsroom has a star on that row and has NOT followed
   * the section it was filed under. Before these two flags were told apart, the
   * button on that row read "Following" and posted to /api/unfollow -- offering to
   * drop a section the reader had never picked up, and doing nothing about the
   * newsroom that actually put the row on their list.
   */
  test('following a newsroom does not make its section followed', async () => {
    const reader = (await one(`insert into users (email) values ('desk@example.com') returning id`))
      .id;
    await db.query(
      `insert into follows (user_id, subject_type, subject_id) values ($1,'team',$2)`,
      [reader, homeId],
    );
    expect(await followsEvent(reader, eventId)).toBe(true);
    expect(await followsSection(reader, eventId)).toBe(false);
  });

  test('following the section is what the row button reads back', async () => {
    const reader = (
      await one(`insert into users (email) values ('section@example.com') returning id`)
    ).id;
    expect(await followsSection(reader, eventId)).toBe(false);
    await db.query(
      `insert into follows (user_id, subject_type, subject_id) values ($1,'league',$2)`,
      [reader, leagueId],
    );
    expect(await followsSection(reader, eventId)).toBe(true);
    expect(await followsEvent(reader, eventId)).toBe(true);
  });

  test('a signed-out visitor has no section followed either', async () => {
    expect(await followsSection(null, eventId)).toBe(false);
  });

  test("one user's follow never leaks into another's view", async () => {
    const stranger = (
      await one(`insert into users (email) values ('stranger@example.com') returning id`)
    ).id;
    expect(await followsEvent(stranger, eventId)).toBe(false);
  });
});
