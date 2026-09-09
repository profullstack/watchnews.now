import { describe, expect, test } from 'bun:test';

// Same reason as watchnews.test.js: the catalogue module reaches @tipoff/db,
// which reads the environment at import, and a static import would hoist above
// the assignment. It needs to be set, not to connect.
process.env.DATABASE_URL = 'postgres://localhost:5432/unused';
const { CATALOG_ADAPTERS } = await import('../packages/sports/src/catalog.js');
const { CATEGORY_SECTION, collect, INDEPENDENT, outletOf, outletSlug, SECTIONS } = await import(
  '../packages/sports/src/brisk.js'
);
const { outletSlug: nichedbSlug } = await import('../packages/sports/src/nichedb.js');

const story = (over = {}) => ({
  uuid: 'https://thebeernut.blogspot.com/2026/09/lough-gill.html',
  title: 'September pairs 4: Lough Gill',
  description: 'At the outset of this series...',
  snippet: 'At the outset of this series...',
  url: 'https://thebeernut.blogspot.com/2026/09/lough-gill.html',
  shortUrl: 'https://brisk.news/a/IK4swc',
  imageUrl: 'https://thebeernut.blogspot.com/img/lough-gill.jpg',
  publishedAt: '2026-09-09T07:39:00+00:00',
  source: 'thebeernut.blogspot.com',
  categories: [],
  source_type: 'rss',
  ...over,
});

const run = (items, section) => {
  const acc = { desks: new Map(), outlets: new Map(), events: [], seen: new Set(), section };
  collect(items, acc);
  return acc;
};

/** A wire row, which only files when a category was asked for. */
const wire = (over = {}) => story({ source_type: 'api', source: 'thehindu.com', ...over });

describe('the brisk provider', () => {
  test('is registered, and its freshness category is one it actually writes', () => {
    const entry = CATALOG_ADAPTERS.find((a) => a.name === 'brisk');
    expect(entry).toBeTruthy();
    expect(typeof entry.module.fetchAll).toBe('function');
    expect(SECTIONS).toContain(entry.category);
  });

  test('every desk it can write is a section the brand offers', async () => {
    const saved = process.env.BRAND;
    process.env.BRAND = 'watchnews';
    try {
      const { brand } = await import(`../packages/config/src/brands.js?t=${Date.now()}`);
      for (const s of SECTIONS) expect(brand.categories).toContain(s);
    } finally {
      if (saved === undefined) delete process.env.BRAND;
      else process.env.BRAND = saved;
    }
  });

  test('every brisk category maps to a desk, and the small web is not one of them', () => {
    for (const [category, section] of Object.entries(CATEGORY_SECTION)) {
      expect(typeof category).toBe('string');
      expect(SECTIONS).toContain(section);
    }
    // An rss row is never returned by a category= query, so this desk cannot be
    // reached by mapping one.
    expect(Object.values(CATEGORY_SECTION)).not.toContain(INDEPENDENT);
    expect(SECTIONS).toContain(INDEPENDENT);
  });

  test('a small-web post becomes a story on the independent desk', () => {
    const { desks, outlets, events } = run([story()]);
    expect(events).toHaveLength(1);
    expect(events[0].category).toBe('independent');
    expect(events[0].name).toBe('September pairs 4: Lough Gill');
    // Published, not scheduled: the tense problem this schema cannot express.
    expect(events[0].state).toBe('out');
    expect([...desks.values()][0].category).toBe('independent');
    expect([...outlets.values()][0].name).toBe('thebeernut.blogspot.com');
  });

  /*
   * A Google row is not an editorial judgement -- its URL 302s back to
   * news.google.com rather than to any publisher, so every one would be a dead
   * link on a site whose promise is showing you who reported it.
   */
  test('drops Google News rows, which are stubs that resolve to nothing', () => {
    const { events } = run(
      [
        story({
          source_type: 'google',
          url: 'https://news.google.com/rss/articles/CBMi',
          source: 'news.google.com',
        }),
        story(),
      ],
      'world',
    );
    expect(events).toHaveLength(1);
    expect(events[0].url).toBe('https://thebeernut.blogspot.com/2026/09/lough-gill.html');
  });

  test('a wire row files under the category that was asked for', () => {
    const { events, desks } = run([wire()], 'technology');
    expect(events).toHaveLength(1);
    expect(events[0].category).toBe('technology');
    expect([...desks.values()][0].name).toBe('Technology');
  });

  /*
   * The row's own `categories` field is empty about as often as not, so a wire
   * row reached without asking for a desk has nothing to attribute it to.
   * Guessing would misfile it; the category pass will pick it up.
   */
  test('a wire row with no desk to attribute it to is skipped, not guessed at', () => {
    expect(run([wire()]).events).toHaveLength(0);
  });

  test('the small web files itself, whichever door it came through', () => {
    // An rss row surfaces in the firehose (no section) and in a search.
    expect(run([story()]).events[0].category).toBe(INDEPENDENT);
    expect(run([story()], 'business').events[0].category).toBe(INDEPENDENT);
  });

  test('one publisher across several desks is one outlet on all of them', () => {
    const { outlets, desks } = run([wire({ url: 'https://thehindu.com/a' })], 'world');
    const second = {
      desks,
      outlets,
      events: [],
      seen: new Set(),
      section: 'business',
    };
    collect([wire({ url: 'https://thehindu.com/b' })], second);
    expect(outlets.size).toBe(1);
    expect([...outlets.values()][0].genreKeys).toHaveLength(2);
  });

  /*
   * The corpus is built from feed documents and a few of them advertise their
   * own comment feed as an entry -- a real post title on a raw XML endpoint.
   */
  test('drops entries that link to a feed rather than to something to read', () => {
    const bad = [
      'https://thebeernut.blogspot.com/feeds/7623507724741893021/comments/default',
      'https://example.com/index.xml',
      'https://example.com/blog/feed/',
      'https://example.com/atom.xml?alt=rss',
    ];
    for (const url of bad) {
      expect(run([story({ url })]).events).toHaveLength(0);
    }
    expect(run([story({ url: 'https://example.com/2026/feeding-the-cat' })]).events).toHaveLength(
      1,
    );
  });

  test('links to the publisher, never to the shortener that hides them', () => {
    const { events } = run([story()]);
    expect(events[0].url).not.toContain('brisk.news');
  });

  /*
   * brisk renders these on demand. Carrying them would point every card on this
   * site at another site's renderer.
   */
  test('drops the on-demand screenshot placeholder but keeps a real image', () => {
    const shot = 'https://brisk.news/api/screenshot?url=https%3A%2F%2Fexample.com';
    expect(run([story({ imageUrl: shot })]).events[0].imageUrl).toBeNull();
    expect(run([story()]).events[0].imageUrl).toBe(
      'https://thebeernut.blogspot.com/img/lough-gill.jpg',
    );
  });

  test('a story with no usable date is skipped, not dated to now', () => {
    expect(run([story({ publishedAt: null })]).events).toHaveLength(0);
    expect(run([story({ publishedAt: 'not a date' })]).events).toHaveLength(0);
  });

  test('the same story on two merged pages is written once', () => {
    const { events, outlets } = run([story(), story(), story()]);
    expect(events).toHaveLength(1);
    expect(outlets.size).toBe(1);
  });

  /*
   * This is the only event key in the codebase whose length a third party
   * chooses -- brisk's identity for a small-web row is the article URL. The
   * UNIQUE (provider, provider_key) btree rejects a row of a few thousand bytes,
   * and that aborts the whole batch rather than dropping the one bad row.
   */
  describe('the story key stays bounded', () => {
    const long = (tail) => `https://example.com/${'a'.repeat(4000)}/${tail}`;

    test('an absurd URL cannot produce an index-breaking key', () => {
      const { events } = run([story({ url: long('one') })]);
      expect(events).toHaveLength(1);
      expect(events[0].providerKey.length).toBeLessThan(256);
    });

    test('two long URLs sharing a prefix stay two stories', () => {
      const { events } = run([
        story({ url: long('one') }),
        story({ url: long('two'), title: 'Second' }),
      ]);
      expect(events).toHaveLength(2);
      expect(events[0].providerKey).not.toBe(events[1].providerKey);
    });

    test('an ordinary URL keeps the readable key', () => {
      const { events } = run([story()]);
      expect(events[0].providerKey).toBe(
        'brisk:story:https-thebeernut-blogspot-com-2026-09-lough-gill-html',
      );
    });
  });

  test('www is stripped so one blog is not two outlets', () => {
    const { outlets } = run([
      story({ source: 'www.example.com', url: 'https://example.com/a' }),
      story({ source: 'example.com', url: 'https://example.com/b' }),
    ]);
    expect(outlets.size).toBe(1);
    expect([...outlets.values()][0].name).toBe('example.com');
  });

  test('a feed title that leaked into the host column is not made an outlet', () => {
    expect(outletOf({ source: 'The Beer Nut' })).toBeNull();
    expect(outletOf({ source: 'localhost' })).toBeNull();
    expect(outletOf({ source: '' })).toBeNull();
    expect(outletOf({ source: 'example.com' })).toEqual({
      key: 'example.com',
      name: 'example.com',
    });
  });

  /*
   * teams.slug is NOT NULL UNIQUE and upsertTeams conflicts on
   * (provider, provider_key), so a slug both providers can produce is a unique
   * violation that aborts the whole batch -- every good row in the pass lost,
   * not just the clashing one. Both identify a publisher by bare host, so this
   * is not hypothetical.
   */
  test('an outlet slug cannot collide with the same publisher under nichedb', () => {
    const outlet = { key: 'theguardian.com', name: 'theguardian.com' };
    const mine = outletSlug(outlet);
    const theirs = nichedbSlug(outlet, 'nichedb:outlet:theguardian.com', new Map());
    expect(mine).not.toBe(theirs);
    expect(mine).toContain('brisk');
  });

  /*
   * leagues.slug is UNIQUE too, and nichedb already owns `world-news` and the
   * rest of these names. Both providers now write those desks.
   */
  test('a desk slug cannot collide with the nichedb desk of the same name', () => {
    const { desks } = run([wire()], 'world');
    const slug = [...desks.values()][0].slug;
    expect(slug).not.toBe('world-news');
    expect(slug).toContain('brisk');
  });

  /*
   * The decoder itself is covered in entities.test.js; these are the two places
   * this adapter has to remember to call it.
   */
  describe('character references', () => {
    test('a title reaches the page as text, not as entities', () => {
      const { events } = run([
        story({ title: 'it&rsquo;s crazy&hellip; a &ldquo;crashout&rdquo;' }),
      ]);
      expect(events[0].name).toBe('it\u2019s crazy\u2026 a \u201ccrashout\u201d');
    });

    test('summaries are decoded too', () => {
      const { events } = run([story({ description: 'Tom &amp; Jerry &#8212; again' })]);
      expect(events[0].summary).toBe('Tom & Jerry \u2014 again');
    });

    test('a title that is nothing but whitespace is not published as a blank card', () => {
      expect(run([story({ title: '&nbsp;' })]).events).toHaveLength(0);
    });
  });

  test('an outlet is filed under the desk it publishes to', () => {
    const { desks, outlets } = run([story()]);
    const deskKey = [...desks.keys()][0];
    expect([...outlets.values()][0].genreKeys).toEqual([deskKey]);
  });
});
