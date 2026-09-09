/**
 * The small web, from brisk.news.
 *
 * brisk.news is ours too, and like nichedb it has already done the fetching and
 * parsing: a `poll-feeds` daemon reads ~33,000 independent feeds -- the Kagi
 * small-web catalogue plus a curated set -- into one table, and publishes the
 * result through a keyless search API at `/api/news`. So this adapter is a
 * projection of that, not a thirteenth feed parser.
 *
 * WHAT IT CONTRIBUTES, AND WHY IT IS NOT THE SAME STORIES TWICE
 *
 * `/api/news` merges three corpora and labels each row with `source_type`:
 *
 * - `api`    -- thenewsapi's mainstream wire. nichedb already carries this
 *               ground (newsroom feeds + GDELT), so taking it here would file
 *               the same story under two desks under two outlets.
 * - `google` -- Google News RSS. Its URLs are `news.google.com/rss/articles/...`
 *               redirect stubs that resolve to nothing without a browser, so a
 *               reader who clicked one would land on a dead end.
 * - `rss`    -- the small-web firehose. Independent blogs, one writer each.
 *               Nobody else here carries it, and "know who reported it" is the
 *               whole brand.
 *
 * Only `rss` is kept. That is the editorial line, not a technicality: this
 * adapter's desk is the independent web, and a wire story is not that.
 *
 * WHY IT GETS A DESK OF ITS OWN, AND WHY THAT IS LOAD-BEARING
 *
 * `syncBrandCatalog` gates each adapter on `lastSyncedAtForCategory(category)`,
 * which is `max(rosters_synced_at) from leagues where sport = $category` -- it
 * does NOT filter by provider. `ingest` then stamps that clock on every league
 * it wrote. So two adapters sharing a `sport` value poison each other's gate:
 * nichedb is registered first, would always stamp `world` first, and brisk would
 * see a fresh clock and skip forever -- and, running the other way, brisk
 * stamping `world` would make nichedb skip. A section only this adapter writes
 * is what keeps both gates honest.
 */

import { getJson } from './http.js';
import { keyFor, slugify } from './slug.js';

const BASE = 'https://brisk.news/api/news';
const PROVIDER = 'brisk';

/**
 * The one desk this adapter files under, and the only one it may file under.
 *
 * Exported as a list to match nichedb's shape, and because `brand.categories`
 * is asserted to be the union of every provider's sections.
 */
export const SECTIONS = ['independent'];

export const SECTION_NAMES = { independent: 'Independent' };

/** Below nichedb's desks in the nav: it is a supplement, not the front page. */
const SECTION_PRIORITY = 200;

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

/** The named references that actually turn up in this corpus, plus the big five. */
const NAMED = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

/**
 * Decode the character references a feed title arrives with.
 *
 * Nothing between the publisher's feed and this row decodes them, so a Tumblr
 * post reaches the page as `it&rsquo;s crazy` -- and JSX escapes on the way out,
 * so the reader sees the entity itself rather than an apostrophe. Measured
 * 2026-09-09: 7 of 76 titles and 17 of 75 summaries in one pass.
 *
 * `&amp;` is resolved LAST, after the numeric pass. Doing it first turns a
 * double-encoded `&amp;#39;` into `&#39;` and then into an apostrophe that was
 * never in the title -- decoding one layer too many is how a feed's literal
 * "&amp;" becomes somebody else's markup.
 */
export function decodeEntities(text) {
  if (text == null) return null;
  const s = String(text)
    .replace(/&#(\d{1,7});/g, (m, d) => safeChar(Number.parseInt(d, 10), m))
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => safeChar(Number.parseInt(h, 16), m))
    .replace(/&([a-z]+);/gi, (m, n) => {
      const key = n.toLowerCase();
      return key === 'amp' ? m : (NAMED[key] ?? m);
    })
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return s || null;
}

/** A code point outside the usable range is left as written rather than guessed at. */
function safeChar(code, original) {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return original;
  // Lone surrogates are unpaired halves and would corrupt the string.
  if (code >= 0xd800 && code <= 0xdfff) return original;
  try {
    return String.fromCodePoint(code);
  } catch {
    return original;
  }
}

/**
 * A story's provider key, bounded.
 *
 * Every other adapter here keys an event on a short upstream id. brisk's `uuid`
 * for a small-web row IS the article URL, so this is the only key in the
 * codebase whose length is somebody else's decision. `provider_key` is `text`,
 * but the UNIQUE (provider, provider_key) btree behind it is not: a row wider
 * than roughly 2700 bytes is rejected outright, and that would abort the whole
 * upsert batch rather than drop the one absurd URL. Truncating alone would make
 * two long URLs sharing a prefix collide into one story, so what is dropped is
 * replaced by a hash of the whole thing.
 */
const KEY_MAX = 200;

function storyKey(url) {
  const slug = keyFor(PROVIDER, 'story', url);
  if (slug.length <= KEY_MAX) return slug;
  // FNV-1a over the full URL: enough to separate two shared prefixes, and no
  // reason to reach for a crypto hash to do it.
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${slug.slice(0, KEY_MAX)}-${h.toString(36)}`;
}

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
async function page({ search = '', pageNo = 1 } = {}) {
  const url =
    `${BASE}?limit=${PAGE}&page=${pageNo}` +
    (search ? `&search=${encodeURIComponent(search)}` : '');
  const res = await getJson(url, { timeoutMs: 30_000 });
  return res?.articles ?? [];
}

/**
 * Turn brisk articles into catalogue rows, accumulating into the maps.
 *
 * Exported so the mapping can be tested without the network -- the filtering is
 * the only part of this adapter with any decisions in it.
 */
export function collect(items, { desks, outlets, events, seen = new Set() }) {
  for (const it of items ?? []) {
    // The editorial line. See the note at the top of this file.
    if (it?.source_type !== 'rss') continue;
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

    const section = SECTIONS[0];
    const deskKey = keyFor(PROVIDER, 'desk', section);
    if (!desks.has(deskKey)) {
      desks.set(deskKey, {
        provider: PROVIDER,
        providerKey: deskKey,
        category: section,
        slug: slugify(`${section}-news`),
        name: SECTION_NAMES[section],
        priority: SECTION_PRIORITY,
      });
    }

    const outletKey = keyFor(PROVIDER, 'outlet', outlet.key);
    if (!outlets.has(outletKey)) {
      outlets.set(outletKey, {
        provider: PROVIDER,
        providerKey: outletKey,
        category: section,
        kind: 'outlet',
        slug: outletSlug(outlet),
        name: outlet.name,
        displayName: outlet.name,
        description: null,
        imageUrl: null,
        url: null,
        genreKeys: [deskKey],
      });
    }

    events.push({
      provider: PROVIDER,
      // The article URL is brisk's own identity for an rss row (its `uuid` is
      // the URL), and it survives a re-poll where a row id might not.
      providerKey: storyKey(it.url),
      category: section,
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
 * Recent independent-web stories, newest first.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxPages] Pages of the plain firehose to walk. Roughly a
 *   third of each is small web, so the default trades ~20 requests for ~200
 *   stories against an interval measured in hours.
 * @param {string[]} [opts.terms] Optional subjects to pull as well. The same
 *   endpoint with `search=` is far denser in small-web rows than the firehose is
 *   (measured: 19 of 20 for `rust`, 3 of 3 for `gardening`), so this is the lever
 *   for deepening a subject without walking the whole firehose. Empty by default:
 *   a hardcoded term list would be an editorial line nobody chose, where "newest
 *   first" is one this brand already states on the page.
 */
export async function fetchAll({ maxPages = 20, terms = [] } = {}) {
  const desks = new Map();
  const outlets = new Map();
  const events = [];
  const seen = new Set();

  for (let p = 1; p <= maxPages; p++) {
    const items = await page({ pageNo: p });
    if (items.length === 0) break;
    collect(items, { desks, outlets, events, seen });
    if (items.length < PAGE) break;
  }

  for (const term of terms) {
    const items = await page({ search: term });
    collect(items, { desks, outlets, events, seen });
  }

  return { genres: [...desks.values()], subjects: [...outlets.values()], events };
}

export const adapter = { name: PROVIDER, category: SECTIONS[0], fetchAll };
