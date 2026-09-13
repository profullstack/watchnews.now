/** Isolate the brand and database adapter from the other test files. */
import { mock } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';
process.env.CACHE_ENABLED = '0';
// The route may offer public channels; this fixture needs no remote catalogue.
globalThis.fetch = async () => {
  throw new Error('network is disabled in this fixture');
};

const db = await PGlite.create({ extensions: { citext, pg_trgm } });
const migrations = new URL('../../packages/db/migrations/', import.meta.url).pathname;
for (const file of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) {
  await db.exec(await readFile(migrations + file, 'utf8'));
}

// Execute the production SQL, changing only the driver's tagged-template shape.
const sql = async (parts, ...values) => {
  const text = parts.reduce((out, part, index) => out + (index ? `$${index}` : '') + part, '');
  return (
    await db.query(
      text,
      values.map((value) => (value instanceof Date ? value.toISOString() : value)),
    )
  ).rows;
};
mock.module(new URL('../../packages/db/src/index.js', import.meta.url).pathname, () => ({ sql }));
mock.module(new URL('../../packages/queue/src/index.js', import.meta.url).pathname, () => ({
  connection: {},
}));

await db.exec(`
  insert into leagues (id, provider, provider_key, sport, slug, name)
    values (1, 'nichedb', 'world', 'world', 'world-news', 'World'),
           (2, 'nichedb', 'science', 'science', 'science-news', 'Science');
  insert into teams (id, provider, provider_key, league_id, slug, name, display_name)
    values (1, 'nichedb', 'daily', 1, 'daily-news', 'Daily News', 'Daily News');
  insert into events (id, provider, provider_key, league_id, home_team_id, starts_at, state, name, url, summary)
    values (1, 'nichedb', 'older', 1, 1, now() - interval '2 days', 'post', 'Older world story', 'https://publisher.example/older', 'An older summary.'),
           (2, 'nichedb', 'latest', 1, 1, now() - interval '1 day', 'post', 'Latest world story', 'https://publisher.example/latest', 'A recent summary.'),
           (3, 'nichedb', 'science', 2, 1, now() - interval '30 hours', 'post', 'Science story', 'https://publisher.example/science', 'Science summary.'),
           (4, 'nichedb', 'future', 1, 1, now() + interval '1 day', 'post', 'Future-dated story', null, null),
           (5, 'nichedb', 'archive', 1, 1, now() - interval '8 days', 'post', 'Archived story', null, null),
           (6, 'nichedb', 'scheduled', 1, 1, now() + interval '2 days', 'pre', 'Scheduled fixture', null, null),
           (7, 'nichedb', 'today', 1, 1, now(), 'pre', 'Today fixture', null, null);
`);

const { app } = await import('../../apps/web/src/app.js');
const { publicEvents } = await import('../../packages/db/src/queries.js');
const { brand } = await import('../../packages/config/src/index.js');
const { Landing } = await import('../../apps/web/src/views/pages.jsx');

const get = async (path, json = false) => {
  const response = await app.request(path);
  if (response.status !== 200)
    throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return json ? response.json() : response.text();
};
const out = {
  brand: brand.id,
  home: await get('/'),
  latest: await get('/results'),
  section: await get(`/${brand.paths.category}/world`),
  about: await get('/about'),
  api: await get('/api/v1/events', true),
  filtered: await get('/api/v1/events?sport=world&league=world-news&limit=1', true),
  docs: await get('/api/v1', true),
  future: await publicEvents({ past: false }),
  empty: Landing({ user: null, today: [] }).toString(),
};
console.log(JSON.stringify(out));
await db.close();
process.exit(0);
