import { describe, expect, test } from 'bun:test';

// The catalogue module reaches @tipoff/db, which reads the environment at
// import, so these are pulled in once the variable exists.
process.env.DATABASE_URL = 'postgres://localhost:5432/unused';
const { CATALOG_ADAPTERS } = await import('../packages/sports/src/catalog.js');
const { collect, isSponsored, masthead, outletOf, outletSlug, SECTIONS, SECTION_NAMES } =
  await import('../packages/sports/src/rssamplifier.js');
const { SECTIONS: BRISK_SECTIONS } = await import('../packages/sports/src/brisk.js');

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-09T08:00:00.000Z');

const item = (over = {}) => ({
  id: 'https://www.eco-business.com/news/malaysia-power-demand/',
  title: 'Data centres are pushing Malaysia’s power demand higher',
  url: 'https://www.eco-business.com/news/malaysia-power-demand/',
  summary: 'The energy regulator said data centres now account for 9.28 per cent.',
  image: 'https://www.eco-business.com/img/hero.jpg',
  date_published: '2026-09-09T05:09:00.000Z',
  _rssamplifier: {
    feed_title: 'Eco-Business',
    feed_page: 'https://rssamplifier.com/eco-business-com-8',
  },
  ...over,
});

const run = (items, section = 'climate') => {
  const acc = {
    desks: new Map(),
    outlets: new Map(),
    events: [],
    seen: new Set(),
    section,
    now: NOW,
  };
  collect(items, acc);
  return acc;
};

describe('the rssamplifier provider', () => {
  test('is registered, and its freshness category is one it actually writes', () => {
    const entry = CATALOG_ADAPTERS.find((a) => a.name === 'rssamplifier');
    expect(entry).toBeTruthy();
    expect(typeof entry.module.fetchAll).toBe('function');
    expect(SECTIONS).toContain(entry.category);
  });

  test('every desk it writes is a section the brand offers, and each has a name', async () => {
    const saved = process.env.BRAND;
    process.env.BRAND = 'watchnews';
    try {
      const { brand } = await import(`../packages/config/src/brands.js?t=${Date.now()}`);
      for (const s of SECTIONS) {
        expect(brand.categories).toContain(s);
        expect(typeof SECTION_NAMES[s]).toBe('string');
        expect(SECTION_NAMES[s].length).toBeGreaterThan(0);
      }
    } finally {
      if (saved === undefined) delete process.env.BRAND;
      else process.env.BRAND = saved;
    }
  });

  /*
   * The small web is a category rssamplifier deliberately keeps apart from news,
   * and brisk already carries it. This adapter is the newsroom one.
   */
  test('it does not claim the small-web desk', () => {
    expect(SECTIONS).not.toContain('independent');
    expect(BRISK_SECTIONS).toContain('independent');
  });

  test('a newsroom story keeps its masthead, not a bare host', () => {
    const { events, outlets, desks } = run([item()]);
    expect(events).toHaveLength(1);
    expect(events[0].category).toBe('climate');
    expect(events[0].state).toBe('out');
    const outlet = [...outlets.values()][0];
    expect(outlet.name).toBe('Eco-Business');
    // Somewhere to send a reader who wants to know who that is.
    expect(outlet.url).toBe('https://rssamplifier.com/eco-business-com-8');
    expect([...desks.values()][0].name).toBe('Climate');
  });

  /*
   * These are inserted one every ten items, ride ON TOP of ?limit=, and are our
   * own crawlproof placements stamped with the day they were served. Ingesting
   * one publishes a house advert as the day's news, every sync.
   */
  describe('sponsored entries', () => {
    const ad = {
      id: 'tag:crawlproof.com,2026:ad/2768fe0d/d/2026-09-09',
      title: 'Fifty tech CEOs, scored on openness (Sponsored)',
      url: 'https://crawlproof.com/a/rNcltabywEbM',
      date_published: '2026-09-09T00:00:00.000Z',
      _rssamplifier: { feed_title: 'CrawlProof', feed_page: 'https://rssamplifier.com/crawlproof' },
    };

    test('are recognised by any of the three markers the document uses', () => {
      expect(isSponsored({ ...ad, id: 'https://example.com/x', _crawlproof: {} })).toBe(true);
      expect(isSponsored({ ...ad, id: 'https://example.com/x', tags: ['Sponsored'] })).toBe(true);
      expect(isSponsored({ ...ad, tags: ['sponsored'] })).toBe(true);
      // The id marker alone, which is what the live payload actually carried.
      expect(isSponsored(ad)).toBe(true);
    });

    test('a real story is not mistaken for one', () => {
      expect(isSponsored(item())).toBe(false);
      expect(isSponsored(item({ tags: ['climate', 'asia'] }))).toBe(false);
      expect(isSponsored(null)).toBe(false);
    });

    test('never reach the catalogue', () => {
      const { events } = run([ad, item()]);
      expect(events).toHaveLength(1);
      expect(events[0].url).not.toContain('crawlproof.com');
    });
  });

  /*
   * A publisher filing a release date as a post date arrives unclamped: a games
   * feed on the sport desk was dated six days out. This brand stores a story as
   * `post` and the home page asks for today, so a future row is filed on a day
   * that has not happened and shows up nowhere.
   */
  describe('publisher clocks', () => {
    test('a story dated days ahead is dropped, not clamped to now', () => {
      const ahead = item({ date_published: new Date(NOW + 6 * 24 * HOUR).toISOString() });
      expect(run([ahead]).events).toHaveLength(0);
    });

    test('ordinary timezone skew of a few minutes is still a story', () => {
      const skewed = item({ date_published: new Date(NOW + 5 * 60_000).toISOString() });
      expect(run([skewed]).events).toHaveLength(1);
    });

    test('an unusable date is skipped rather than dated to now', () => {
      expect(run([item({ date_published: null })]).events).toHaveLength(0);
      expect(run([item({ date_published: 'whenever' })]).events).toHaveLength(0);
    });
  });

  /*
   * A climate story is also a science story, so one pass over twelve desks sees
   * the same URL more than once.
   */
  test('a story filed under two topics is written once, on the first desk', () => {
    const acc = {
      desks: new Map(),
      outlets: new Map(),
      events: [],
      seen: new Set(),
      section: 'climate',
      now: NOW,
    };
    collect([item()], acc);
    collect([item()], { ...acc, section: 'science' });
    expect(acc.events).toHaveLength(1);
    expect(acc.events[0].category).toBe('climate');
  });

  test('one newsroom across two desks is one outlet on both', () => {
    const acc = {
      desks: new Map(),
      outlets: new Map(),
      events: [],
      seen: new Set(),
      section: 'climate',
      now: NOW,
    };
    collect([item()], acc);
    collect([item({ url: 'https://www.eco-business.com/news/other/' })], {
      ...acc,
      section: 'science',
    });
    expect(acc.outlets.size).toBe(1);
    expect([...acc.outlets.values()][0].genreKeys).toHaveLength(2);
  });

  /*
   * The directory holds eight feeds whose page slug starts `eco-business-com`.
   * The slug is the identity, so two publications sharing a title stay two rows.
   */
  test('the feed page slug is the outlet identity, not the title', () => {
    const a = outletOf(item());
    const b = outletOf(
      item({
        _rssamplifier: {
          feed_title: 'Eco-Business',
          feed_page: 'https://rssamplifier.com/eco-business-com-3',
        },
      }),
    );
    expect(a.key).toBe('eco-business-com-8');
    expect(b.key).toBe('eco-business-com-3');
    expect(a.key).not.toBe(b.key);
    // And so must their slugs, or the pair is a unique violation that aborts
    // the whole batch. A live pass over 393 outlets found exactly this.
    expect(outletSlug(a)).not.toBe(outletSlug(b));
  });

  /*
   * A masthead is whatever the publisher put in their feed <title>, and plenty
   * are a name followed by a sales pitch. Carried whole that is the outlet name
   * on every card.
   */
  describe('mastheads', () => {
    test('a long name with a tagline is cut back to the publication', () => {
      expect(
        masthead('Al Jazeera &#8211; Breaking News, World News and Video from Al Jazeera'),
      ).toBe('Al Jazeera');
      expect(masthead('The Guardian | Latest news, sport and opinion from the Guardian')).toBe(
        'The Guardian',
      );
    });

    /*
     * The length rule earns its keep here: both of these have a separator and a
     * useless left-hand side, and cutting them would make the name worse.
     */
    test('a short name is left alone even though it has a separator', () => {
      expect(masthead('News - Tennisuptodate.com')).toBe('News - Tennisuptodate.com');
      expect(masthead('Daily Express :: World Feed')).toBe('Daily Express :: World Feed');
    });

    test('entities are decoded before anything is measured or cut', () => {
      expect(masthead('Caf&#233; Society')).toBe('Café Society');
      expect(masthead('Tom &amp; Jerry')).toBe('Tom & Jerry');
    });

    test('nothing usable is null rather than an outlet with a blank name', () => {
      expect(masthead('')).toBeNull();
      expect(masthead(null)).toBeNull();
      expect(masthead('&nbsp;')).toBeNull();
    });
  });

  test('an item with no masthead is not made an outlet', () => {
    expect(outletOf({ _rssamplifier: { feed_page: 'https://rssamplifier.com/x' } })).toBeNull();
    expect(outletOf({})).toBeNull();
    expect(run([item({ _rssamplifier: {} })]).events).toHaveLength(0);
  });

  /*
   * teams.slug and leagues.slug are both UNIQUE while the upserts conflict on
   * (provider, provider_key), so a slug another provider can produce is a unique
   * violation that aborts the whole pass.
   */
  test('outlet and desk slugs cannot collide with the other two providers', () => {
    const { outlets, desks } = run([item()]);
    /*
     * The tag is 'rsa', not the provider name: slugify keeps only the LAST
     * EIGHT characters of its discriminator, so 'rssamplifier' would arrive as
     * 'mplifier' and every outlet would read `eco-business-mplifier`.
     */
    expect([...outlets.values()][0].slug).toBe('eco-business-com-8-rsa');
    const deskSlug = [...desks.values()][0].slug;
    expect(deskSlug).toBe('climate-news-rsa');
    expect(deskSlug).not.toBe('climate-news');
    expect(deskSlug).not.toBe('climate-news-brisk');
    expect(outletSlug({ key: 'eco-business-com-8' })).not.toContain('mplifier');
  });

  test('links to the publisher, not to a reader view on somebody else site', () => {
    const { events } = run([item({ readUrl: 'https://rssamplifier.com/x/read?p=y' })]);
    expect(events[0].url).toBe('https://www.eco-business.com/news/malaysia-power-demand/');
    expect(events[0].url).not.toContain('rssamplifier.com');
  });

  test('a section is required, or a story has no desk to land on', () => {
    const acc = { desks: new Map(), outlets: new Map(), events: [], seen: new Set(), now: NOW };
    collect([item()], acc);
    expect(acc.events).toHaveLength(0);
  });
});
