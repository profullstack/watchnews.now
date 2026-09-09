import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The catalogue module reaches @tipoff/db, which reads the environment at import.
// Static imports hoist above an assignment, so these are pulled in dynamically
// once the variable exists. It needs to be set, not to connect.
process.env.DATABASE_URL = 'postgres://localhost:5432/unused';
const { CATALOG_ADAPTERS } = await import('../packages/sports/src/catalog.js');
const { collect, outletOf, pickChannels, SECTION_NAMES, SECTIONS, sectionOf } = await import(
  '../packages/sports/src/nichedb.js'
);

const load = async (id) => {
  const saved = process.env.BRAND;
  process.env.BRAND = id;
  try {
    return await import(`../packages/config/src/brands.js?b=${id}&t=${Date.now()}`);
  } finally {
    if (saved === undefined) delete process.env.BRAND;
    else process.env.BRAND = saved;
  }
};

/** A story as nichedb's /api/v1/items actually returns it. */
const gdeltStory = {
  id: 1732512,
  adapter: 'gdelt',
  kind: 'story',
  title: 'Saudi Warehousing & Logistics Expo brings together industry leaders',
  summary: null,
  url: 'https://www.arabnews.com/saudi-arabia/expo-3000957',
  image_url: 'https://assets.example/one.jfif',
  published_at: '2026-09-08T18:15:00.000Z',
  time_known: true,
  precision: 'minute',
  tags: ['news', 'business', 'gdelt', 'economy'],
  data: {
    section: 'business',
    query: 'economy',
    domain: 'arabnews.com',
    country: 'Saudi Arabia',
    language: 'English',
  },
};

const feedStory = {
  id: 1731542,
  adapter: 'newsfeed',
  kind: 'story',
  title: "Beijing Signals Readiness to Talk to Trump's Team",
  summary: 'The Chinese foreign minister spoke by phone.',
  url: 'https://www.wsj.com/articles/beijing-2faddbec',
  image_url: null,
  published_at: '2026-09-08T00:58:00.000Z',
  time_known: true,
  precision: 'minute',
  tags: ['news', 'world', 'dj'],
  data: {
    section: 'world',
    feed: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml',
    outlet: 'dj',
    categories: ['PAID'],
  },
};

const empty = () => ({ beats: new Map(), outlets: new Map(), events: [] });

describe('the watchnews brand', () => {
  test('reads news in its own vocabulary', async () => {
    const { brand, Word } = await load('watchnews');
    expect(brand.id).toBe('watchnews');
    expect(brand.domain).toBe('watchnews.now');
    expect(brand.words.event).toBe('story');
    expect(brand.words.participant).toBe('outlet');
    expect(brand.words.collection).toBe('section');
    // Not "Kickoff", not "Out" — a story is already published when you see it.
    expect(Word.starts).toBe('Published');
  });

  /*
   * The first cut had a single "news" category above a "beat" tier, which gave
   * a nav with one entry and the URL /news/news. Sections are the category tier
   * precisely so that cannot happen again.
   */
  test('the sections are the categories, so there is no /news/news', async () => {
    const { brand, href } = await load('watchnews');
    /*
     * The desks the one provider writes, and nothing else. A section listed
     * here that nichedb never files under is a nav entry leading to an empty
     * page; one it files under that is missing here is a story on a section the
     * site does not offer.
     */
    expect(brand.categories).toEqual(SECTIONS);
    expect(new Set(brand.categories).size).toBe(brand.categories.length);
    expect(brand.categories).not.toContain('news');
    expect(brand.categories.length).toBeGreaterThan(5);
    expect(href.category('politics')).toBe('/news/politics');
  });

  test('links are built from the paths routes are registered from', async () => {
    const { href, brand } = await load('watchnews');
    expect(href.collection('world-news')).toBe('/sections/world-news');
    expect(href.participant('bbc-news')).toBe('/outlets/bbc-news');
    expect(href.collection('x').startsWith(`/${brand.paths.collection}/`)).toBe(true);
  });

  /*
   * One provider, on purpose. The directories this brand's stories come from
   * are sources inside nichedb's news collection, where the deduplication is.
   * Reading them here as well gave every desk a row per provider -- three
   * sections all called "World" -- and the same publisher two outlet pages.
   */
  test('runs the one news provider, and signposts the categories it does not carry', async () => {
    const { brand } = await load('watchnews');
    expect(brand.providers).toEqual(['nichedb']);
    // Sport here is a news desk, not fixtures — tipoffwatch does those properly.
    expect(brand.elsewhere.sports).toBe('https://tipoffwatch.com');
  });

  test('marks stories up as news, not as fixtures', async () => {
    const { brand } = await load('watchnews');
    expect(brand.schema.event).toBe('NewsArticle');
    expect(brand.schema.participant).toBe('NewsMediaOrganization');
  });

  test('carries every copy key the other brands do', async () => {
    const news = await load('watchnews');
    const sports = await load('tipoffwatch');
    const genre = await load('genrewatch');
    expect(Object.keys(news.brand.copy).sort()).toEqual(Object.keys(genre.brand.copy).sort());
    for (const k of Object.keys(sports.brand.copy)) {
      expect(typeof news.brand.copy[k]).toBe('string');
      expect(news.brand.copy[k].length).toBeGreaterThan(0);
    }
  });

  test('no reader-facing copy still calls a section a beat', async () => {
    const { brand } = await load('watchnews');
    for (const [k, v] of Object.entries(brand.copy)) {
      expect(`${k}:${v}`.toLowerCase()).not.toContain('beat');
    }
    expect(brand.description.toLowerCase()).not.toContain('beat');
  });

  /*
   * This brand's events are all in the past, so the countdown pages have nothing
   * to count down to. That has to be said out loud rather than left as an empty
   * page under a sports sentence.
   */
  test('says plainly that news is not scheduled in advance', async () => {
    const { brand } = await load('watchnews');
    expect(brand.copy.soonBlurb).toContain('empty');
    expect(brand.copy.soonEmpty).toMatch(/not announced in advance/);
  });
});

describe('the nichedb provider', () => {
  test('is registered, and its freshness category is one it actually writes', () => {
    const entry = CATALOG_ADAPTERS.find((a) => a.name === 'nichedb');
    expect(entry).toBeTruthy();
    expect(typeof entry.module.fetchAll).toBe('function');
    // The gate itself now asks by provider, but this still has to name a desk
    // the adapter writes: 'news' is not one of the nine and would describe
    // nothing.
    expect(SECTIONS).toContain(entry.category);
  });

  test('the section is read from nichedb, not guessed from the text', () => {
    expect(sectionOf(feedStory)).toBe('world');
    expect(sectionOf(gdeltStory)).toBe('business');
    expect(sectionOf({ adapter: 'newsfeed', data: { section: 'politics' } })).toBe('politics');
  });

  test('a row written before sections existed still finds its desk', () => {
    // Nothing re-fetches an old row, so without this every stored story would
    // lose its home the moment sections shipped.
    expect(sectionOf({ adapter: 'gdelt', data: { query: 'election' } })).toBe('politics');
    expect(sectionOf({ adapter: 'gdelt', data: { query: 'economy' } })).toBe('business');
    expect(sectionOf({ adapter: 'newsfeed', data: {} })).toBe('world');
  });

  test('an unknown section is dropped rather than bucketed', () => {
    expect(sectionOf({ adapter: 'gdelt', data: { section: 'astrology' } })).toBeNull();
    expect(sectionOf({ adapter: 'other', data: {} })).toBeNull();
  });

  test('an outlet is the publisher, or the domain when that is all there is', () => {
    expect(outletOf(feedStory)).toEqual({ key: 'dj', name: 'The Wall Street Journal' });
    expect(outletOf(gdeltStory)).toEqual({ key: 'arabnews.com', name: 'arabnews.com' });
    // www. and bare are the same publisher, not two to follow separately.
    expect(outletOf({ data: { domain: 'www.arabnews.com' } }).key).toBe('arabnews.com');
    expect(outletOf({ data: {} })).toBeNull();
  });

  /*
   * The newsroom directory upstream identifies a feed by its own slug, which is
   * unique, stable and unreadable. Title-casing `eco-business-com-8` puts
   * "Eco Business Com 8" on every card, so the masthead the upstream sends wins
   * where it exists -- and the key stays the slug, because two publications can
   * share a name and must not share an outlet.
   */
  test('a masthead from upstream beats a title-cased slug', () => {
    const story = {
      data: { outlet: 'eco-business-com-8', outletName: 'Eco-Business', section: 'climate' },
    };
    expect(outletOf(story)).toEqual({ key: 'eco-business-com-8', name: 'Eco-Business' });

    // Two feeds, one masthead: still two outlets.
    const other = { data: { outlet: 'eco-business-com-3', outletName: 'Eco-Business' } };
    expect(outletOf(other).key).not.toBe(outletOf(story).key);

    // The feeds that send no masthead are unchanged: a known slug keeps its
    // real name, an unknown one is still title-cased, and a blank does not win.
    expect(outletOf(feedStory).name).toBe('The Wall Street Journal');
    expect(outletOf({ data: { outlet: 'npr', outletName: '  ' } }).name).toBe('NPR');
    expect(outletOf({ data: { outlet: 'some-local-paper' } }).name).toBe('Some Local Paper');
  });

  test('the section becomes the category, which is what puts it in the nav', () => {
    const acc = empty();
    collect([gdeltStory, feedStory], acc);
    expect(acc.events).toHaveLength(2);
    const sections = [...acc.beats.values()];
    expect(sections.map((b) => b.category).sort()).toEqual(['business', 'world']);
    expect(sections.map((b) => b.name).sort()).toEqual(['Business', 'World']);
    // Title-casing "us" gets you "Us", which is why there is a name table.
    expect(SECTION_NAMES.us).toBe('US');

    const [story] = acc.events;
    expect(story.kind).toBe('story');
    // 'out' is what stateOf turns into 'post'. Nothing here is ever 'pre'.
    expect(story.state).toBe('out');
    expect(story.startsAt.toISOString()).toBe('2026-09-08T18:15:00.000Z');
    expect(story.venueRegion).toBe('Saudi Arabia');
  });

  test('an outlet publishing on two desks accumulates them rather than forking', () => {
    const acc = empty();
    collect(
      [gdeltStory, { ...gdeltStory, id: 2, data: { ...gdeltStory.data, section: 'politics' } }],
      acc,
    );
    expect(acc.outlets.size).toBe(1);
    expect([...acc.outlets.values()][0].genreKeys).toHaveLength(2);
  });

  test('outlets get a readable slug, not a truncated discriminator', () => {
    const acc = empty();
    collect([feedStory, gdeltStory], acc);
    const slugs = [...acc.outlets.values()].map((o) => o.slug);
    expect(slugs).toContain('the-wall-street-journal');
    expect(slugs).toContain('arabnews-com');
    // The old form kept only the last 8 characters of the key: al-jazeera-ljazeera.
    expect(slugs.some((s) => s.endsWith('-ljazeera'))).toBe(false);
  });

  test('two outlets that would share a slug do not both claim it', () => {
    const acc = empty();
    // A domain under the .news TLD against the publisher named the same thing:
    // teams.slug is UNIQUE, so this would abort the batch rather than look odd.
    collect(
      [
        { ...feedStory, id: 10, data: { section: 'world', outlet: 'bbci' } },
        { ...gdeltStory, id: 11, data: { section: 'world', domain: 'bbc.news' } },
      ],
      acc,
    );
    const slugs = [...acc.outlets.values()].map((o) => o.slug);
    expect(acc.outlets.size).toBe(2);
    expect(new Set(slugs).size).toBe(2);
    expect(slugs).toContain('bbc-news');
  });

  test('a story with no usable timestamp is skipped, not dated to now', () => {
    const acc = empty();
    collect(
      [
        { ...gdeltStory, published_at: null },
        { ...gdeltStory, published_at: 'nonsense' },
      ],
      acc,
    );
    expect(acc.events).toHaveLength(0);
  });

  test('every shipped section has a reader-facing name', () => {
    for (const s of SECTIONS) {
      expect(typeof SECTION_NAMES[s]).toBe('string');
      expect(SECTION_NAMES[s].length).toBeGreaterThan(0);
    }
  });
});

/*
 * The whitelabel only holds if the views actually use it. These strings were
 * hardcoded, so they read correctly on the sports brand and wrongly on the other
 * two: the footer told every reader of watchnews.now that "TipoffWatch is free",
 * and a news section said it had "1 leagues".
 */
describe('no view hardcodes the sports vocabulary', () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url).pathname, 'utf8');
  const pages = read('apps/web/src/views/pages.jsx');
  const layout = read('apps/web/src/views/Layout.jsx');

  test('the footer names the brand it is serving', () => {
    expect(layout).not.toContain('TipoffWatch is free');
    expect(layout).toContain('{brand.name} is free');
  });

  test("the browse blurb is per brand, not one site's sentence", () => {
    expect(pages).not.toContain('Pick a sport, then a league');
    expect(pages).toContain('brand.copy.browseBlurb');
  });

  test("counts are pluralised in the brand's own words", () => {
    // "1 leagues" on a news site, and "leagues" at all on two of three brands.
    expect(pages).not.toMatch(/\{s\.leagues\} leagues/);
    expect(pages).not.toMatch(/\{leagues\.length\} leagues\./);
    expect(pages).not.toMatch(/'league' : 'leagues'/);
    expect(pages).not.toMatch(/'team' : 'teams'/);
  });

  test('every brand carries the browse blurb', async () => {
    for (const id of ['tipoffwatch', 'genrewatch', 'watchnews']) {
      const { brand } = await load(id);
      expect(typeof brand.copy.browseBlurb).toBe('string');
      expect(brand.copy.browseBlurb.length).toBeGreaterThan(10);
    }
  });
});

describe('categoryLabel', () => {
  test('an initialism stays an initialism', async () => {
    const { categoryLabel } = await import('../apps/web/src/views/pages.jsx');
    // The whole reason this exists: "us" is a desk, and both "us" and "Us" are wrong.
    expect(categoryLabel('us')).toBe('US');
    expect(categoryLabel('world')).toBe('World');
    expect(categoryLabel('technology')).toBe('Technology');
    expect(categoryLabel('mixed-martial-arts')).toBe('Mixed Martial Arts');
    expect(categoryLabel('')).toBe('');
  });
});

/*
 * The leaks that reached a reader's inbox and home screen, not just a page.
 */
describe('nothing outside the brand file names one site at another', () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url).pathname, 'utf8');

  test('the sign-in email is from the site the reader is signing in to', () => {
    const notify = read('packages/notify/src/index.js');
    // Delivered for real on 2026-09-08 with the subject "Your TipoffWatch
    // sign-in link" to someone signing in to watchnews.now.
    expect(notify).not.toContain('TipoffWatch');
    expect(notify).toContain('${brand.name} sign-in link');
  });

  test('the home-screen name and logo are the brand, not the flagship', () => {
    const layout = read('apps/web/src/views/Layout.jsx');
    expect(layout).not.toContain('content="Tipoff"');
    expect(layout).not.toContain('alt="TipoffWatch"');
  });

  test('the footer credits the upstreams this brand actually reads', () => {
    const layout = read('apps/web/src/views/Layout.jsx');
    // A credit naming the wrong upstream is worse than none: a reader takes it
    // as a fact about where what they are looking at came from.
    expect(layout).not.toContain('https://www.espn.com');
    expect(layout).toContain('brand.sources');
  });

  test('every brand declares its own sources and invite reason', async () => {
    for (const id of ['tipoffwatch', 'genrewatch', 'watchnews']) {
      const { brand } = await load(id);
      expect(brand.sources.list.length).toBeGreaterThan(0);
      for (const src of brand.sources.list) {
        expect(src.name.length).toBeGreaterThan(1);
        expect(src.url).toMatch(/^https:\/\//);
      }
      expect(typeof brand.copy.inviteReason).toBe('string');
    }
    const news = await load('watchnews');
    expect(news.brand.sources.list.some((s) => /gdelt/i.test(s.name))).toBe(true);
  });
});

describe('which channels a page offers', () => {
  const ch = (id, name, country) => ({
    id,
    name,
    country,
    norm: name.toLowerCase(),
    streamUrl: `https://cdn/${id}.m3u8`,
  });
  const all = [
    ch('1', 'VIP News', 'US'),
    ch('2', 'BBC News', 'GB'),
    ch('3', 'BBC World News', 'GB'),
    ch('4', 'Sky News', 'GB'),
    ch('5', 'WSOC Now', 'US'),
  ];

  test('a newsroom finds its own channel, not everything with "news" in it', () => {
    // Measured against the real directory, the two-way substring test this
    // replaced answered "BBC News" with VIP News first.
    const picked = pickChannels(all, { outlet: 'BBC News', limit: 3 }).map((c) => c.name);
    expect(picked.slice(0, 2).sort()).toEqual(['BBC News', 'BBC World News']);
    expect(picked[0]).not.toBe('VIP News');
  });

  test('a place-shaped desk is filtered to that country', () => {
    const picked = pickChannels(all, { section: 'us', limit: 9 });
    expect(picked.every((c) => c.country === 'US')).toBe(true);
  });

  test('a page with nothing to match on still gets channels', () => {
    // An empty "where to watch" box is the thing this feature exists to avoid.
    expect(pickChannels(all, { section: 'world', limit: 3 })).toHaveLength(3);
  });

  test('no channel is offered twice, and the limit holds', () => {
    const picked = pickChannels(all, { outlet: 'BBC News', limit: 4 });
    expect(new Set(picked.map((c) => c.id)).size).toBe(picked.length);
    expect(picked.length).toBeLessThanOrEqual(4);
  });
});

/*
 * The player is the house one, and this test exists because it was not.
 *
 * The first cut of the channel page hand-rolled hls.js and added a second copy
 * of it to the tree, next to a package that already does exactly this job and
 * is already a dependency. Worse, it tried native HLS first on the strength of
 * canPlayType -- which lies on Chrome -- so it would have silently played
 * nothing for most readers.
 */
describe('the channel player is @profullstack/player', () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url).pathname, 'utf8');

  test('the entry uses the house player rather than a bare engine', () => {
    const entry = read('apps/web/src/client/watch-entry.js');
    expect(entry).toContain("from '@profullstack/player'");
    expect(entry).toContain('createPlayer');
    // The engine ladder belongs to the package. A page that reaches for hls.js
    // or sniffs support itself has started a second ladder that will drift.
    // Matched as CALLS, not as text: the file explains the canPlayType trap in
    // a comment, and a test that cannot tell those apart forbids the comment.
    expect(entry).not.toMatch(/new\s+Hls\(/);
    expect(entry).not.toMatch(/\.canPlayType\(/);
  });

  test('the page mounts a stage and loads the bundle, not a private script', () => {
    const view = read('apps/web/src/views/watch.jsx');
    expect(view).toContain('channel-stage');
    expect(view).toContain('vendor-watch.js');
    expect(view).toContain('vendor-player.css');
    expect(view).not.toContain('vendor-hls.js');
  });

  test('assetUrl is called with a bare filename, never a rooted path', () => {
    // assetUrl already prepends the slash, so passing '/vendor-watch.js' emits
    // `//vendor-watch.js` -- a protocol-relative URL the browser resolves to the
    // HOST `vendor-watch.js`. It fails DNS, so the player bundle never loads and
    // the channel page sits on "Starting..." forever. It looked like a dead
    // stream rather than a missing script, and shipped because the old assertion
    // was a substring: '//vendor-watch.js' contains '/vendor-watch.js'.
    for (const f of ['apps/web/src/views/watch.jsx', 'apps/web/src/views/Layout.jsx']) {
      expect(read(f)).not.toMatch(/assetUrl\(\s*['"`]\//);
    }
  });

  test('the channel page emits same-origin asset URLs', async () => {
    const { WatchChannel } = await import('../apps/web/src/views/watch.jsx');
    const out = WatchChannel({
      user: null,
      channel: { id: '1', name: 'X', country: 'US', quality: '720p', website: null },
      also: [],
    }).toString();
    expect(out).toMatch(/src="\/vendor-watch\.js(\?v=[^"]+)?"/);
    expect(out).toMatch(/href="\/vendor-player\.css(\?v=[^"]+)?"/);
    expect(out).not.toContain('"//');
  });

  test('no second copy of hls.js is pinned at the root', () => {
    // The package brings its own, and the build swaps it for the light one.
    const root = JSON.parse(read('package.json'));
    expect(root.dependencies?.['hls.js']).toBeUndefined();
    expect(read('apps/web/package.json')).toContain('@profullstack/player');
  });

  test('the watch bundle gets the same HLS-only treatment as radio', () => {
    const build = read('apps/web/build-client.js');
    expect(build).toContain("['watch-entry.js', 'vendor-watch.js']");
    expect(build).toContain('PLAYER_BUNDLES');
  });
});

describe('a story is not a fixture', () => {
  const story = {
    id: 1634,
    name: 'US slaps import ban on Canadian alcohol and other goods',
    short_name: null,
    starts_at: new Date('2026-09-09T04:12:00Z'),
    state: 'post',
    league_name: 'Technology',
    league_slug: 'technology-news',
    league_id: 7,
    sport: 'technology',
    home_name: 'BBC News',
    home_slug: 'bbc-news',
    home_team_id: 42,
    away_name: null,
    away_slug: null,
    away_team_id: null,
    home_score: null,
    away_score: null,
    summary: 'Washington has widened the list of goods facing tariffs.',
    image_url: 'https://ichef.bbci.co.uk/news/1024/lead.jpg',
    url: 'https://www.bbc.co.uk/news/articles/abc123',
    time_known: true,
    precision: 'minute',
  };

  const renderStory = async ({ props = {}, ...over } = {}) => {
    const { EventPage } = await import('../apps/web/src/views/pages.jsx');
    return EventPage({
      user: null,
      event: { ...story, ...over },
      plays: [],
      comments: [],
      offers: [],
      ...props,
    }).toString();
  };

  test('a one-sided event never prints the Home/Away placeholders', async () => {
    // `contested` was Boolean(home || away), so a story -- whose single subject is
    // the outlet that published it -- took the two-sided path and rendered the side
    // it did not have as the literal words. Live on /events/1634 this read
    // "Away - vs - Home BBC News" over an article about import tariffs.
    const out = await renderStory();
    expect(out).not.toMatch(/>Away</);
    expect(out).not.toMatch(/>Home</);
    expect(out).not.toContain('role-tag');
    expect(out).not.toContain('class="scoreboard');
  });

  test('the headline is the heading, with the outlet and the time under it', async () => {
    const out = await renderStory();
    expect(out).toContain('<h1>US slaps import ban on Canadian alcohol and other goods</h1>');
    expect(out).toContain('class="lead-story"');
    // The participant path is the brand's own word -- /outlets on the news brand,
    // /teams under the default this file loads. The point is that the byline links
    // to the publisher at all, not which noun the route uses.
    expect(out).toMatch(/href="\/(outlets|teams)\/bbc-news"/);
    expect(out).toContain('2026-09-09T04:12:00.000Z');
  });

  test('the image, the summary and a way to go and read it', async () => {
    const out = await renderStory();
    expect(out).toContain('https://ichef.bbci.co.uk/news/1024/lead.jpg');
    expect(out).toContain('Washington has widened the list of goods facing tariffs.');
    expect(out).toContain('https://www.bbc.co.uk/news/articles/abc123');
    expect(out).toContain('Read at BBC News');
    // Leaving for someone else's site: never hand them our opener.
    expect(out).toMatch(/rel="noopener[^"]*"/);
  });

  test('a real fixture still gets its scoreboard', async () => {
    // The guard against fixing news by breaking sport. Two named sides is still a
    // contest and must render exactly as it did.
    const out = await renderStory({
      away_name: 'Coventry',
      away_slug: 'coventry',
      away_team_id: 9,
      summary: null,
      image_url: null,
      url: null,
    });
    expect(out).toContain('class="scoreboard');
    expect(out).not.toContain('class="lead-story"');
  });

  test('a story page offers the outlet channels', async () => {
    const out = await renderStory({
      props: { watch: [{ id: '1733425', name: 'BBC News', country: 'GB', quality: '1080p' }] },
    });
    expect(out).toContain('Watch BBC News');
    expect(out).toContain('href="/watch/1733425"');
  });
});

describe('the feed a reader actually subscribes to', () => {
  const readSrc = (f) => readFileSync(new URL(`../${f}`, import.meta.url).pathname, 'utf8');

  test('the all feed asks for what this brand publishes, not only what is next', () => {
    // /feeds/all.xml served 200, correct headers and zero items on watchnews: a
    // story is published before anyone can read it, so a forward-looking window
    // selects none of them while the front page was showing sixty.
    const src = readSrc('apps/web/src/app.js');
    expect(src).toContain('past: brand.eventsArePast');
    expect(src).not.toContain("title: 'TipoffWatch");
    expect(src).not.toContain('Upcoming fixtures across 354 leagues');
  });

  test('feedEvents can look backwards, newest first', () => {
    const src = readSrc('packages/db/src/queries.js');
    expect(src).toContain('past = false');
    expect(src).toMatch(/order by e\.starts_at desc/);
  });

  test('nothing in the feed is branded for another site', () => {
    const src = readSrc('apps/web/src/lib/rss.js');
    expect(src).not.toContain('<generator>TipoffWatch</generator>');
    expect(src).not.toContain('tipoffwatch-event-');
  });

  test('only the brand whose events are past is marked as such', async () => {
    for (const id of ['tipoffwatch', 'genrewatch']) {
      const { brand } = await load(id);
      expect(brand.eventsArePast).toBeFalsy();
      expect(brand.copy.feedBlurb).toBeTruthy();
    }
    const { brand } = await load('watchnews');
    expect(brand.eventsArePast).toBe(true);
    expect(brand.copy.feedBlurb).toBeTruthy();
  });
});

describe('a story keeps what the provider collected', () => {
  const readSrc = (f) => readFileSync(new URL(`../${f}`, import.meta.url).pathname, 'utf8');

  test('the catalogue writer carries summary, image and link', () => {
    // Collected by collect() in nichedb.js on every crawl and dropped on the floor
    // here, because there were no columns to put them in.
    const src = readSrc('packages/sports/src/catalog.js');
    expect(src).toContain('summary: e.summary');
    expect(src).toContain('image_url: e.imageUrl');
    expect(src).toContain('url: e.url');
  });

  test('and the upsert does not wipe them on the next pass', () => {
    const src = readSrc('packages/db/src/queries.js');
    expect(src).toContain('summary = coalesce(excluded.summary, events.summary)');
    expect(src).toContain('image_url = coalesce(excluded.image_url, events.image_url)');
    expect(src).toContain('url = coalesce(excluded.url, events.url)');
  });

  test('there is a migration that adds the columns', () => {
    const src = readSrc('packages/db/migrations/0037_story_fields.sql');
    for (const col of ['summary', 'image_url', 'url']) {
      expect(src).toContain(`add column if not exists ${col}`);
    }
  });
});
