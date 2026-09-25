import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const read = (p) => readFile(new URL(p, import.meta.url).pathname, 'utf8');

const { channelsFromCountry, countryIndex, pickChannels, regionOf } = await import(
  '../packages/sports/src/nichedb.js'
);

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
    expect(countryIndex([])).toEqual([]);
    expect(countryIndex(undefined)).toEqual([]);
    expect(channelsFromCountry([], 'DE')).toEqual([]);
  });
});

describe('browsing by country', () => {
  /*
   * The fault this replaced. The index was grouped by SIZE, so a reader landed on
   * one country's 256 regional desks and scrolled past every one of them to reach
   * anywhere else. Size was never what anybody was looking for.
   */
  test('regions and countries are alphabetical, never by size', () => {
    const index = countryIndex(lopsided);
    expect(index.map((r) => r.region)).toEqual([...index.map((r) => r.region)].sort());
    for (const r of index) {
      expect(r.countries.map((c) => c.code)).toEqual([...r.countries.map((c) => c.code)].sort());
    }
    // The deepest country is present and is emphatically not first.
    const asia = index.find((r) => r.region === 'Asia');
    expect(asia.countries.find((c) => c.code === 'IN').count).toBe(51);
    expect(index[0].region).not.toBe('Asia');
  });

  test('every channel is counted once, under one region', () => {
    const index = countryIndex(lopsided);
    const counted = index.reduce((n, r) => n + r.total, 0);
    expect(counted).toBe(lopsided.length);
    const codes = index.flatMap((r) => r.countries.map((c) => c.code));
    expect(new Set(codes).size).toBe(codes.length);
  });

  test('a country with no region lands in Elsewhere rather than vanishing', () => {
    // GS and VR are both in the live directory and neither is in the region map.
    const index = countryIndex([...lopsided, ch(77, 'Somewhere Else', 'GS')]);
    const elsewhere = index.find((r) => r.region === 'Elsewhere');
    expect(elsewhere.countries.map((c) => c.code)).toEqual(['GS']);
    expect(regionOf('GS')).toBe('Elsewhere');
    expect(regionOf(null)).toBe('Elsewhere');
  });

  test('the regions put the obvious countries where a reader expects them', () => {
    expect(regionOf('UK')).toBe('Europe');
    expect(regionOf('us')).toBe('Americas');
    expect(regionOf('IN')).toBe('Asia');
    expect(regionOf('QA')).toBe('Middle East');
    expect(regionOf('ZA')).toBe('Africa');
    expect(regionOf('AU')).toBe('Oceania');
  });

  test('one country, on its own page', () => {
    expect(channelsFromCountry(lopsided, 'de').map((c) => c.name)).toEqual(['Tagesschau']);
    expect(channelsFromCountry(lopsided, 'IN')).toHaveLength(51);
    expect(channelsFromCountry(lopsided, 'ZZ')).toEqual([]);
    expect(channelsFromCountry(lopsided, null)).toEqual([]);
  });

  test('every code the live directory carries has a name, not a code', async () => {
    const { countryName } = await import('../apps/web/src/views/watch.jsx');
    // The 117 nichedb carries as of 2026-09-25. A code as a heading reads like a
    // database, which is the thing this page is trying not to be.
    const LIVE = (
      'AE AF AL AM AR AU AZ BA BD BE BF BG BJ BO BR BS BY BZ CA CD CH CI CL CM CN CO CR CU CY ' +
      'CZ DE DO DZ EC EG ES ET FI FR GE GN GR GT HK HN HR HT HU ID IE IL IN IQ IR IS IT JO JP ' +
      'KE KG KH KR KW KZ LA LB LT LY MA MC MD MK MM MN MO MT MV MX MY NE NG NI NL OM PA PE PH ' +
      'PK PL PR PS PT PY QA RO RU SA SD SE SG SK SN SV SY TG TH TR TW UA UK US UZ VE VN XK YE ZA'
    ).split(' ');
    const bare = LIVE.filter((code) => countryName(code) === code);
    expect(bare).toEqual([]);
    // And every one of them has a region.
    expect(LIVE.filter((code) => regionOf(code) === 'Elsewhere')).toEqual([]);
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

describe('matching an article to a stream', () => {
  /*
   * Ripped out. `eventName` is a HEADLINE on this brand, so matching channel titles
   * against its words hunted for a channel called Canada, or Toronto, and offered
   * that as "where to watch this story". It also crowded the candidate window:
   * matchTerms takes the first 3,000 rows in position order, so headline words
   * pushed out the terms that mean something before the ranker saw them.
   *
   * What a story has to offer is its desk and the outlet that filed it, which the
   * public channel box on the same page has always keyed on.
   */
  test('the headline is not a search term where events are articles', async () => {
    const src = await read('../packages/playlists/src/index.js');
    const at = src.indexOf('export async function ownChannelsForEvent(');
    const body = src.slice(at, src.indexOf('\n}', at));
    expect(body).toContain('eventName: brand.eventsArePast ? null : event.name');
    // The desk and the outlet are still passed, because they are the whole match now.
    expect(body).toContain('leagueName: event.league_name');
    expect(body).toContain('home: event.home_name');
  });

  test('a fixture brand still matches on the event name', async () => {
    const { matchTerms } = await import('../packages/sports/src/m3u.js');
    // Nothing about matchTerms changed: a race or a fight card still has its name as
    // the only handle there is. The decision is at the call site.
    expect(matchTerms({ eventName: 'Monaco Grand Prix' })).toContain('monaco');
  });

  /*
   * And the page's other channel box was always right, so it is untouched: outlet
   * first, section as the fallback.
   */
  test('the public box on an article still keys on the outlet and the desk', async () => {
    const app = await read('../apps/web/src/app.js');
    expect(app).toContain('channelsFor({ outlet: event.home_name, section: event.sport, limit: 6 })');
  });
});

describe('the watch index is a browse page, not a dump', () => {
  test('it renders a sample and an index rather than every channel', async () => {
    const app = await read('../apps/web/src/app.js');
    const at = app.indexOf("app.get('/watch', async (c) => {");
    const body = app.slice(at, at + 1400);
    // 963 rows and 113KB was the old page.
    expect(body).toContain('pickChannels(all, { limit: 12 })');
    expect(body).toContain('countryIndex(all)');
    expect(body).not.toContain('channelsByCountry');
  });

  test('a country is a path, not a query string, so it can be indexed', async () => {
    const app = await read('../apps/web/src/app.js');
    const country = app.indexOf("app.get('/watch/country/:code'");
    const index = app.indexOf("app.get('/watch', async (c) => {");
    const byId = app.indexOf("app.get('/watch/:id'");
    expect(country).toBeGreaterThan(-1);
    // Before the catch-all id route: relying on 'country' not looking like an id is
    // the kind of thing that breaks the day somebody adds a slug.
    expect(country).toBeLessThan(byId);
    expect(index).toBeGreaterThan(-1);
    // Two letters only, because this string reaches a page title.
    expect(app.slice(country, country + 500)).toContain('/^[A-Za-z]{2}$/');
  });

  test('searching by name is offered, because a thousand channels is a lot to browse', async () => {
    const view = await read('../apps/web/src/views/watch.jsx');
    expect(view).toContain('action="/watch"');
    expect(view).toContain('name="q"');
    const app = await read('../apps/web/src/app.js');
    expect(app).toContain("pickChannels(all, { q, limit: 40 })");
  });
});
