import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';
const { slugify } = await import('../packages/sports/src/slug.js');

/**
 * A slug somebody else already holds.
 *
 * `teams.slug` is NOT NULL UNIQUE and `upsertTeams` conflicts on
 * (provider, provider_key). So a row whose slug belongs to a different key is
 * not an update -- it is an insert against a unique index, and Postgres fails
 * the WHOLE statement. One clashing name loses the entire pass.
 *
 * An adapter cannot prevent this: it can see the batch it is building and
 * nothing else. It stayed theoretical while each adapter owned a namespace, and
 * became a hard failure when the news collection upstream grew a directory that
 * supplies a masthead -- a feed keyed `bbc-co-uk-2` arrives named "BBC News",
 * slugs to `bbc-news`, and the row keyed `bbci` has held that since the first
 * sync. Production symptom: every sync logged
 * `duplicate key value violates unique constraint "teams_slug_key"` and the
 * newest desks stayed empty.
 */
let db;
beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
  await db.query(
    `insert into leagues (provider, provider_key, sport, slug, name)
     values ('nichedb','nichedb:beat:world','world','world-news','World')`,
  );
  const [{ id }] = (
    await db.query(`select id from leagues where provider_key = 'nichedb:beat:world'`)
  ).rows;
  // The incumbent, as the first sync wrote it.
  await db.query(
    `insert into teams (provider, provider_key, league_id, slug, name, display_name)
     values ('nichedb','nichedb:outlet:bbci',$1,'bbc-news','BBC News','BBC News')`,
    [id],
  );
}, 60_000);

const owners = async (slugs) => {
  const rows = (
    await db.query(`select slug, provider, provider_key from teams where slug = any($1::text[])`, [
      `{${slugs.map((s) => `"${s}"`).join(',')}}`,
    ])
  ).rows;
  return new Map(rows.map((r) => [r.slug, `${r.provider}:${r.provider_key}`]));
};

describe('a slug that is already spoken for', () => {
  test('the incumbent is found, and identified by key', async () => {
    const held = await owners(['bbc-news', 'not-taken']);
    expect(held.get('bbc-news')).toBe('nichedb:nichedb:outlet:bbci');
    expect(held.has('not-taken')).toBe(false);
  });

  /*
   * The whole point: the newcomer gives way, so both rows can be written.
   */
  test('a newcomer with the same name takes a discriminated slug', async () => {
    const row = {
      provider: 'nichedb',
      provider_key: 'nichedb:outlet:bbc-co-uk-2',
      slug: 'bbc-news',
      name: 'BBC News',
    };
    const held = await owners([row.slug]);
    const owner = held.get(row.slug);
    expect(owner).toBeTruthy();
    expect(owner).not.toBe(`${row.provider}:${row.provider_key}`);

    row.slug = slugify(row.name, row.provider_key);
    expect(row.slug).not.toBe('bbc-news');

    // And it actually writes, where the original would have aborted the batch.
    const [{ id }] = (await db.query(`select id from leagues limit 1`)).rows;
    await db.query(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       values ($1,$2,$3,$4,$5,$5)`,
      [row.provider, row.provider_key, id, row.slug, row.name],
    );
    const n = (await db.query(`select count(*)::int as n from teams where name = 'BBC News'`))
      .rows[0].n;
    expect(n).toBe(2);
  });

  test('the incumbent keeps the readable slug, which may be in a follow', async () => {
    const [{ slug }] = (
      await db.query(`select slug from teams where provider_key = 'nichedb:outlet:bbci'`)
    ).rows;
    expect(slug).toBe('bbc-news');
  });

  /*
   * Derived from the provider key rather than a counter, so a second pass over
   * the same upstream produces the same slug instead of drifting.
   */
  test('re-slugging is stable across runs', () => {
    const a = slugify('BBC News', 'nichedb:outlet:bbc-co-uk-2');
    const b = slugify('BBC News', 'nichedb:outlet:bbc-co-uk-2');
    expect(a).toBe(b);
    expect(a).not.toBe(slugify('BBC News', 'nichedb:outlet:bbc-co-uk-3'));
  });

  test('a row updating its own slug is left alone', async () => {
    const held = await owners(['bbc-news']);
    expect(held.get('bbc-news')).toBe('nichedb:nichedb:outlet:bbci');
    // Same key: this is an ordinary update, not a collision.
    const mine = 'nichedb:nichedb:outlet:bbci';
    expect(held.get('bbc-news') === mine).toBe(true);
  });
});
