import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const read = (p) => readFile(new URL(p, import.meta.url).pathname, 'utf8');

const { channelsByCountry, pickChannels } = await import('../packages/sports/src/nichedb.js');

const ch = (id, name, country) => ({
  id: String(id),
  name,
  country,
  norm: name.toLowerCase(),
});

/*
 * The shape the live directory actually has: it is a crawl, so it is not evenly
 * spread, and the arrival order buries everything behind the deepest country.
 * Measured 2026-09-25: 51 of the first 60 channels on /watch were from one.
 */
const lopsided = [
  ...Array.from({ length: 51 }, (_, i) => ch(100 + i, `Indian Desk ${i + 1}`, 'IN')),
  ch(1, 'Oplot TV', 'RU'),
  ch(2, 'Novyny.Live', 'UA'),
  ch(3, 'Tagesschau', 'DE'),
  ch(4, 'Digi24', 'RO'),
  ch(5, 'ABC News Live', 'US'),
];

describe('which channels a page with nothing to match on shows', () => {
  test('one country cannot be the whole page', async () => {
    const got = pickChannels(lopsided, { limit: 8 });
    const countries = new Set(got.map((c) => c.country));
    // Six countries exist in the fixture; a first page of eight must reach all of
    // them before taking a second from the deepest.
    expect(countries.size).toBe(6);
    expect(got.filter((c) => c.country === 'IN').length).toBe(3);
  });

  test('the deep country still fills the tail rather than being dropped', () => {
    const got = pickChannels(lopsided, { limit: 56 });
    expect(got).toHaveLength(56);
    expect(got.filter((c) => c.country === 'IN').length).toBe(51);
  });

  /*
   * The spread is a FALLBACK. When the page named something, that answer comes
   * first and in its own order -- a reader on an outlet's page asked about that
   * outlet, not about the world.
   */
  test('a named match still wins', () => {
    const got = pickChannels(lopsided, { outlet: 'Tagesschau', limit: 3 });
    expect(got[0].name).toBe('Tagesschau');
  });

  test('a channel with no country is not lost', () => {
    const got = pickChannels([...lopsided, ch(9, 'Somewhere', null)], { limit: 8 });
    expect(got.some((c) => c.name === 'Somewhere')).toBe(true);
  });

  test('an empty directory is not an exception', () => {
    expect(pickChannels([], { limit: 8 })).toEqual([]);
    expect(channelsByCountry([])).toEqual([]);
    expect(channelsByCountry(undefined)).toEqual([]);
  });
});

describe('grouping the watch index', () => {
  test('biggest group first, and every channel in exactly one', () => {
    const groups = channelsByCountry(lopsided);
    expect(groups[0]).toEqual({ country: 'IN', channels: groups[0].channels });
    expect(groups[0].channels).toHaveLength(51);
    expect(groups.reduce((n, g) => n + g.channels.length, 0)).toBe(lopsided.length);
    const ids = groups.flatMap((g) => g.channels.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a code with no name still makes a heading', async () => {
    const { countryName } = await import('../apps/web/src/views/watch.jsx');
    expect(countryName('DE')).toBe('Germany');
    expect(countryName('in')).toBe('India');
    // Better a code than a blank heading.
    expect(countryName('ZZ')).toBe('ZZ');
  });
});

describe('the door to the channels', () => {
  /*
   * There are about a thousand live channels behind /watch, and before this the
   * only link to any of them was the "where to watch" box on an individual
   * article: not the nav, not the front page, not the browse page. The surface was
   * reachable only by somebody who already knew the URL.
   */
  test('the nav carries it, gated the same way the routes are', async () => {
    const layout = await read('../apps/web/src/views/Layout.jsx');
    expect(layout).toContain('href="/watch"');
    expect(layout).toContain("brand.providers.includes('nichedb') && config.playlists.enabled");
  });

  test('the front page and the browse page both offer channels', async () => {
    const pages = await read('../apps/web/src/views/pages.jsx');
    expect((pages.match(/heading="Watch the news live"/g) ?? []).length).toBe(2);
    const app = await read('../apps/web/src/app.js');
    // Six on the front page, which is a door; eight on the browse page.
    expect(app).toContain('watch={publicChannelsOn() ? await channelsFor({ limit: 6 }) : []}');
    expect(app).toContain('watch={publicChannelsOn() ? await channelsFor({ limit: 8 }) : []}');
  });
});

describe('following a section from the browse page', () => {
  /*
   * Every category on this brand holds exactly one section, so the level between
   * them is a pass-through: the tile named the thing and the button to follow it
   * was one click further in, on a page holding that same single section.
   */
  test('a category holding one section carries its button', async () => {
    const { SportsIndex } = await import('../apps/web/src/views/pages.jsx');
    const html = String(
      await SportsIndex({
        user: { id: 'u1' },
        sports: [
          {
            sport: 'world',
            leagues: 1,
            only_league_id: 12,
            only_league_name: 'World news',
            only_league_following: false,
          },
        ],
        watch: [],
        leagueCounts: null,
        upcoming: 0,
        live: [],
        liveTotal: 0,
        soon: [],
        soonTotal: 0,
        soonHours: 4,
      }).toString(),
    );
    expect(html).toContain('name="subject_type" value="league"');
    expect(html).toContain('name="subject_id" value="12"');
    // Structural, not a literal: this repo's default brand is the sports one, where
    // the same page is /sports rather than /news. What matters is that the button
    // posts back to the page the reader is on.
    expect(html).toMatch(/name="next" value="\/[a-z]+"/);
  });

  test('a category holding several carries none, because there is nothing to post', async () => {
    const { SportsIndex } = await import('../apps/web/src/views/pages.jsx');
    const html = String(
      await SportsIndex({
        user: { id: 'u1' },
        sports: [
          {
            sport: 'sport',
            leagues: 3,
            only_league_id: null,
            only_league_name: null,
            only_league_following: null,
          },
        ],
        watch: [],
        leagueCounts: null,
        upcoming: 0,
        live: [],
        liveTotal: 0,
        soon: [],
        soonTotal: 0,
        soonHours: 4,
      }).toString(),
    );
    expect(html).not.toContain('name="subject_type" value="league"');
  });

  /*
   * The count guard lives in SQL, and it has to: `bool_or` over two sections says
   * "you follow one of these", which is not a state a button can post back.
   */
  test('the query only carries a section where the category holds exactly one', async () => {
    const queries = await read('../packages/db/src/queries.js');
    const at = queries.indexOf('export async function listSports(');
    const body = queries.slice(at, queries.indexOf('\n}', at));
    expect(body).toContain('viewerId');
    expect((body.match(/case when count\(\*\) = 1 then/g) ?? []).length).toBe(3);
    expect(body).toContain("f.subject_type = 'league'");
    const app = await read('../apps/web/src/app.js');
    expect(app).toContain('q.listSports({ viewerId: user?.id ?? null })');
  });

  /*
   * A form inside an anchor is invalid markup, so the button has to be a sibling of
   * the link and the card has to be the list item.
   */
  test('the card is the list item, so the button is not inside the link', async () => {
    const css = await read('../apps/web/public/styles.css');
    expect(css).toMatch(/ul\.sports li \{[^}]*border: 1px solid var\(--line\)/);
    expect(css).toMatch(/ul\.sports li:hover \{[^}]*border-color/);
    const pages = await read('../apps/web/src/views/pages.jsx');
    const at = pages.indexOf('<ul class="sports">');
    const block = pages.slice(at, pages.indexOf('</ul>', at));
    // The anchor closes before the button opens.
    expect(block.indexOf('</a>')).toBeLessThan(block.indexOf('<FollowButton'));
  });
});
