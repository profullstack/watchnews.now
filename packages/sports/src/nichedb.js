/**
 * News, from nichedb.dev.
 *
 * Unlike every other adapter here, the upstream is ours: nichedb's `news`
 * collection already does the fetching, parsing and deduplication against
 * newsroom RSS and GDELT, and exposes the result as keyless JSON. So this
 * adapter is a projection, not a scraper — which is the point of having built
 * the collection there rather than a seventh set of feed parsers here.
 *
 * How news lands in a schema built for fixtures:
 *
 * - a **beat** becomes a league row. GDELT items carry their beat directly
 *   (`data.query`); newsroom items come from world desks, so their beat is
 *   `world` — that is a description of those seven feeds, not a catch-all.
 * - an **outlet** becomes a team row. For newsroom items that is the publisher
 *   (`data.outlet`); for GDELT it is the source domain, which is why this brand
 *   has hundreds of followable outlets rather than seven.
 * - a **story** becomes an event with one side, the way a race already is.
 *
 * The one thing the shared schema cannot express is tense. A fixture is
 * something that will happen; a story has already been published. Stories are
 * therefore ingested as `out`, which `stateOf` stores as `post`, and they reach
 * a reader through the home page (which asks for today, not for upcoming) and
 * the results page. Nothing here is ever `pre`, so this brand's "starting soon"
 * page is empty by construction rather than by accident, and its copy says so.
 */

import { getJson } from './http.js';
import { keyFor, normaliseTitle, slugify } from './slug.js';

const BASE = 'https://nichedb.dev/api/v1';
const PROVIDER = 'nichedb';

/**
 * The desks this brand serves, in the order a reader should meet them.
 *
 * These ARE the `sport` column values, so they are what `brand.categories`
 * lists and what `/news/<section>` addresses. nichedb files every story under
 * one of them, so this list is a mirror of what that collection produces rather
 * than a taxonomy invented here.
 */
export const SECTIONS = [
  'world',
  'us',
  'politics',
  'business',
  'technology',
  'science',
  'health',
  'sport',
  'climate',
  /*
   * The three desks no newsroom feed publishes and GDELT has no notion of.
   * They reach the collection through the newsroom directory nichedb reads, so
   * they arrive here the same way every other desk does.
   */
  'entertainment',
  'food',
  'travel',
  /*
   * Not a newsroom desk at all: the small web, one writer per feed. It is kept
   * apart rather than mixed into a section a reader opened expecting the wire.
   */
  'independent',
];

/** Names a reader would write. Title-casing "us" gets you "Us". */
export const SECTION_NAMES = {
  world: 'World',
  us: 'US',
  politics: 'Politics',
  business: 'Business',
  technology: 'Technology',
  science: 'Science',
  health: 'Health',
  sport: 'Sport',
  climate: 'Climate',
  entertainment: 'Entertainment',
  food: 'Food',
  travel: 'Travel',
  independent: 'Independent',
};

/** Where each desk sits on the front page. Lower sorts first. */
const SECTION_PRIORITY = {
  world: 10,
  us: 20,
  politics: 30,
  business: 40,
  // Below the newsrooms: a supplement to the wire rather than the front page.
  independent: 200,
};

/** nichedb caps a page at 200 however much you ask for. */
const PAGE = 200;

/** Publisher slugs are delivery-host derived, so give the known ones real names. */
export const OUTLET_NAMES = {
  bbci: 'BBC News',
  aljazeera: 'Al Jazeera',
  theguardian: 'The Guardian',
  dw: 'Deutsche Welle',
  france24: 'France 24',
  npr: 'NPR',
  dj: 'The Wall Street Journal',
};

const titleCase = (s) =>
  String(s ?? '')
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/**
 * The desk a story belongs on.
 *
 * nichedb states it outright: a newsroom feed is configured per desk, and a
 * GDELT beat is mapped to the section a reader would look under. So this reads
 * a fact rather than classifying text.
 *
 * The `data.query` fallback is for rows written before sections existed —
 * nothing re-fetches an old row, so without it every story already stored would
 * lose its home the moment this shipped. An unrecognised section is dropped
 * rather than bucketed, because a desk nobody would choose to browse is not a
 * desk.
 */
export function sectionOf(item) {
  const raw = item?.data?.section ?? LEGACY_BEAT[item?.data?.query] ?? null;
  const section = typeof raw === 'string' ? raw.trim().toLowerCase() : null;
  if (section && SECTIONS.includes(section)) return section;
  // A pre-sections newsroom row: every default feed back then was a world desk.
  return item?.adapter === 'newsfeed' ? 'world' : null;
}

/** How GDELT beats were filed before nichedb sent a section of its own. */
const LEGACY_BEAT = { election: 'politics', economy: 'business', conflict: 'world' };

/**
 * The outlet that published a story, as {key, name}.
 *
 * A GDELT row names a domain and nothing friendlier, so the domain is the name.
 * Stripping `www.` matters: the same publisher arrives both ways and would
 * otherwise become two outlets a reader has to follow separately.
 */
export function outletOf(item) {
  const d = item?.data ?? {};
  if (typeof d.outlet === 'string' && d.outlet.trim()) {
    const slug = d.outlet.trim().toLowerCase();
    /*
     * A masthead when the upstream has one, and it usually does now.
     *
     * The directory nichedb reads identifies a feed by its own slug --
     * `eco-business-com-8`, which is unique and stable and completely
     * unreadable. Title-casing that gives "Eco Business Com 8" on every card.
     * It also sends `outletName`, which is what the publisher calls itself,
     * so that wins where it exists. The title-cased slug stays as the fallback
     * for the newsroom feeds, whose outlet key is already a name.
     */
    const name =
      typeof d.outletName === 'string' && d.outletName.trim()
        ? d.outletName.trim()
        : (OUTLET_NAMES[slug] ?? titleCase(slug));
    return { key: slug, name };
  }
  if (typeof d.domain === 'string' && d.domain.trim()) {
    const host = d.domain
      .trim()
      .toLowerCase()
      .replace(/^www\./, '');
    return { key: host, name: host };
  }
  return null;
}

/**
 * The URL an outlet lives at.
 *
 * `slugify(name, key)` would be unique on its own, but it keeps only the LAST
 * EIGHT characters of the discriminator, which turns Al Jazeera into
 * `al-jazeera-ljazeera` — a URL that reads like a bug. Publisher names and
 * domains are already distinct within their own group, so the plain slug is
 * used, and the discriminated form is kept as the fallback for the one case
 * that could genuinely collide: a domain under a word TLD, `bbc.news` against
 * the outlet named BBC News. `teams.slug` is UNIQUE, so a clash would abort the
 * whole upsert batch rather than merely look wrong.
 */
export function outletSlug(outlet, outletKey, outlets) {
  const plain = slugify(outlet.name);
  for (const row of outlets.values()) {
    if (row.slug === plain && row.providerKey !== outletKey) {
      return slugify(outlet.name, outlet.key);
    }
  }
  return plain;
}

/** Fetch one keyset page of a kind. */
async function page(kind, before) {
  const url =
    `${BASE}/items?collection=news&kind=${encodeURIComponent(kind)}&limit=${PAGE}` +
    (before ? `&before=${encodeURIComponent(before)}` : '');
  const res = await getJson(url, { timeoutMs: 30_000 });
  return res?.items ?? [];
}

/**
 * Turn a page of nichedb items into catalogue rows, accumulating into the maps.
 *
 * Exported so the mapping can be tested without the network, which is the only
 * part of this adapter with any decisions in it.
 */
export function collect(items, { beats, outlets, events }) {
  for (const it of items ?? []) {
    if (!it?.id || !it.title) continue;
    const publishedAt = it.published_at ? new Date(it.published_at) : null;
    // A story with no timestamp cannot be placed on a day, and the home page is
    // a day. Skipped rather than dated to "now", which would make every backfill
    // look like breaking news.
    if (!publishedAt || Number.isNaN(publishedAt.getTime())) continue;

    const section = sectionOf(it);
    const outlet = outletOf(it);
    if (!section || !outlet) continue;

    const beatKey = keyFor(PROVIDER, 'beat', section);
    if (!beats.has(beatKey)) {
      beats.set(beatKey, {
        provider: PROVIDER,
        providerKey: beatKey,
        // The section IS the category, which is what puts it in the nav and at
        // /news/<section> instead of the single "news" category this started as.
        category: section,
        slug: slugify(`${section}-news`),
        name: SECTION_NAMES[section] ?? titleCase(section),
        priority: SECTION_PRIORITY[section] ?? 100,
      });
    }

    const outletKey = keyFor(PROVIDER, 'outlet', outlet.key);
    if (!outlets.has(outletKey)) {
      outlets.set(outletKey, {
        provider: PROVIDER,
        providerKey: outletKey,
        category: section,
        kind: 'outlet',
        slug: outletSlug(outlet, outletKey, outlets),
        name: outlet.name,
        displayName: outlet.name,
        description: null,
        imageUrl: null,
        url: null,
        genreKeys: [],
      });
    }
    // An outlet publishes across beats, so its set accumulates.
    const row = outlets.get(outletKey);
    if (!row.genreKeys.includes(beatKey)) row.genreKeys.push(beatKey);

    events.push({
      provider: PROVIDER,
      providerKey: keyFor(PROVIDER, 'story', String(it.id)),
      category: section,
      subjectKey: outletKey,
      kind: 'story',
      startsAt: publishedAt,
      // Wire copy carries a real timestamp; nothing here is a date-only guess.
      timeKnown: it.time_known !== false,
      precision: it.precision ?? 'minute',
      // Published, not scheduled. See the note at the top of this file.
      state: 'out',
      name: it.title,
      shortName: null,
      summary: it.summary ?? null,
      imageUrl: it.image_url ?? null,
      url: it.url ?? null,
      venue: null,
      venueRegion: it.data?.country ?? null,
      season: null,
      number: null,
      runtimeMin: null,
    });
  }
}

/**
 * Recent stories, newest first.
 *
 * WHY THE WINDOW IS THIS BIG
 *
 * The upstream cursor is `before=<id>`, so "newest" means most recently
 * INSERTED, not most recently published. That is fine while sources trickle,
 * and badly wrong the moment one of them writes in bulk: the directory source
 * upstream walks its desks in order and inserts a couple of hundred stories per
 * desk, so a single pass lays down thousands of rows whose ids run in desk
 * order.
 *
 * A thousand-item window landed entirely inside the tail of one such pass.
 * Measured live 2026-09-09, the newest 1,000 upstream items were 195 food, 172
 * climate, 138 travel -- and 1 US, 1 technology, 2 business, because those desks
 * were written first and had been pushed out. The site showed those desks with
 * outlets and no stories at all. Across the newest 4,000 the same data is
 * healthy: 687 world, 325 politics, 301 business, 257 US, 228 technology.
 *
 * So the window has to be wide enough to span a whole upstream refresh rather
 * than a slice of one. nichedb is ours and answers in milliseconds, so the cost
 * is twenty requests; the thing being bought is every desk having stories.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxPages] 200 items each. The ceiling is how much
 *   history is worth carrying and how wide one upstream pass is, not a rate
 *   limit.
 */
export async function fetchAll({ maxPages = 20 } = {}) {
  const beats = new Map();
  const outlets = new Map();
  const events = [];

  let before;
  for (let i = 0; i < maxPages; i++) {
    const items = await page('story', before);
    if (items.length === 0) break;
    collect(items, { beats, outlets, events });
    before = items[items.length - 1]?.id;
    if (!before || items.length < PAGE) break;
  }

  return { genres: [...beats.values()], subjects: [...outlets.values()], events };
}

/* ------------------------------------------------------------- watch this -- */

/**
 * Live news channels, for the "you cannot tune in to a story" problem.
 *
 * A fixture has a broadcast: the thing on screen IS the thing you followed. A
 * story does not. Nobody streams a single article, so the honest answer to
 * "where do I watch this" on a news page is not one channel but the channels
 * covering that desk right now.
 *
 * These stay in nichedb rather than being copied into this database. The rows
 * are public and shared by every reader, where this app's own channel tables are
 * per-account by design -- "a list belongs to exactly one account and is never
 * resold or pooled" -- so seeding 920 public channels into a personal playlist
 * would fight that schema rather than use it.
 */
export async function fetchChannels({ maxPages = 6 } = {}) {
  const out = [];
  let before;
  for (let i = 0; i < maxPages; i++) {
    const items = await page('channel', before);
    if (items.length === 0) break;
    for (const it of items) {
      const d = it?.data ?? {};
      // A channel with no stream is not an answer to "where do I watch this".
      if (!it?.title || !d.streamUrl) continue;
      out.push({
        id: String(it.id),
        name: it.title,
        country: d.country ?? null,
        network: d.network ?? null,
        website: d.website ?? null,
        streamUrl: d.streamUrl,
        quality: d.quality ?? null,
        norm: normaliseTitle(it.title),
      });
    }
    before = items[items.length - 1]?.id;
    if (!before || items.length < PAGE) break;
  }
  return out;
}

/** Desks that are about a place rather than a subject. */
const SECTION_COUNTRY = { us: 'US' };

/**
 * The channels worth offering on a page.
 *
 * Matching is on the normalised title, the same reduction this repo already uses
 * to match a fixture against a channel in someone's playlist, so "BBC News HD"
 * and "bbc news" meet.
 *
 * A page with nothing specific to match on still gets channels. That is
 * deliberate: the alternative on a news page is an empty "where to watch" box,
 * and "here is what is on" is a better answer than nothing when the thing you
 * were reading was never on television in the first place.
 */
/**
 * Words that identify nobody.
 *
 * Nearly every channel in a news directory has "news" in its name, so matching
 * on it matches everything. Measured: asking for "BBC News" put *VIP News*
 * first, because a naive two-way substring test lets any channel whose whole
 * name is a common word match every query.
 */
const GENERIC = new Set(['news', 'tv', 'the', 'channel', 'live', 'hd', 'network']);

const distinctive = (title) =>
  normaliseTitle(title)
    .split(/\s+/)
    .filter((w) => w && !GENERIC.has(w));

/**
 * One channel per country before a second from the same one.
 *
 * The directory is not evenly spread and there is no reason it would be: it is
 * whatever the crawler found. Measured on the live list, 51 of the first 60
 * channels were from one country -- so every page with nothing specific to match
 * on, the browse index included, showed a wall of one country's regional desks to
 * a reader who had been reading about somewhere else. That is not a ranking, it is
 * the order the rows happened to arrive in.
 *
 * Round-robin fixes it without pretending to know which country somebody wants:
 * the first N channels are N different countries where there are that many, and
 * the deep countries still fill the tail.
 */
function spreadByCountry(list) {
  const queues = new Map();
  for (const c of list) {
    const key = c.country ?? '';
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(c);
  }
  const out = [];
  const lanes = [...queues.values()];
  for (let i = 0; out.length < list.length; i++) {
    let moved = false;
    for (const lane of lanes) {
      if (i < lane.length) {
        out.push(lane[i]);
        moved = true;
      }
    }
    // Every lane is exhausted. Without this a list whose longest lane is shorter
    // than the loop's guess spins forever.
    if (!moved) break;
  }
  return out;
}

/**
 * Where each country sits, for a browse page.
 *
 * 117 countries is too many to put in front of somebody as one list, and it is the
 * only facet this directory actually has: country is filled on every channel,
 * network on a fifth of them, and there is no genre field and no logo at all. So
 * the axis has to be country, and country has to be grouped or it is a wall.
 *
 * Six regions rather than continents exactly: "Middle East" is how a news audience
 * divides the map even though it is not a continent, and it is the grouping that
 * makes Al Jazeera and Al Arabiya findable together. Anything unlisted lands in
 * Elsewhere rather than being dropped.
 *
 * Codes are nichedb's, which is ISO-3166 with two house exceptions: UK rather than
 * GB, and XK for Kosovo.
 */
const REGION = {
  Africa: 'BF BJ CD CI CM DZ EG ET GN KE LY MA NE NG SD SN TG ZA',
  Americas: 'AR BO BR BS BZ CA CL CO CR CU DO EC GT HN HT MX NI PA PE PR PY SV US VE',
  Asia: 'AF AM AZ BD CN GE HK ID IN JP KG KH KR KZ LA MM MN MO MV MY PH PK SG TH TW UZ VN',
  Europe: 'AL BA BE BG BY CH CY CZ DE ES FI FR GR HR HU IE IS IT LT MC MD MK MT NL PL PT RO RU SE SK UA UK XK',
  'Middle East': 'AE IL IQ IR JO KW LB OM PS QA SA SY TR YE',
  Oceania: 'AU',
};

const REGION_OF = new Map();
for (const [region, codes] of Object.entries(REGION)) {
  for (const code of codes.split(' ')) REGION_OF.set(code, region);
}

/** Which region a channel's country belongs to. */
export const regionOf = (country) => REGION_OF.get(String(country ?? '').toUpperCase()) ?? 'Elsewhere';

/**
 * The browse index: every region, and every country inside it with a count.
 *
 * Alphabetical at both levels and NOT by size, which is the whole point. Ordering
 * by size put one country's 256 regional desks at the top of the page and left a
 * reader on an English-language news site scrolling past them to reach anything
 * else -- the same fault as the unordered list it replaced, one level up.
 */
export function countryIndex(channels) {
  const counts = new Map();
  for (const c of channels ?? []) {
    const code = (c.country ?? '').toUpperCase();
    if (!code) continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const regions = new Map();
  for (const [code, count] of counts) {
    const region = regionOf(code);
    if (!regions.has(region)) regions.set(region, []);
    regions.get(region).push({ code, count });
  }
  return [...regions.entries()]
    .map(([region, countries]) => ({
      region,
      countries: countries.sort((a, b) => a.code.localeCompare(b.code)),
      total: countries.reduce((n, c) => n + c.count, 0),
    }))
    .sort((a, b) => a.region.localeCompare(b.region));
}

/** Every channel from one country, by its code. */
export function channelsFromCountry(channels, code) {
  const want = String(code ?? '').toUpperCase();
  if (!want) return [];
  return (channels ?? []).filter((c) => (c.country ?? '').toUpperCase() === want);
}

export function pickChannels(channels, { section, outlet, q, limit = 12 } = {}) {
  const list = channels ?? [];
  const country = SECTION_COUNTRY[section] ?? null;
  const pool = country ? list.filter((c) => c.country === country) : list;

  // Every distinctive word has to be present, so "BBC News" finds BBC News and
  // BBC World News and not everything else with "news" in it.
  const wanted = distinctive(q ?? outlet ?? '');
  const named = wanted.length
    ? pool.filter((c) => {
        const norm = ` ${c.norm} `;
        return wanted.every((w) => norm.includes(` ${w} `) || c.norm.includes(w));
      })
    : [];

  const seen = new Set();
  const ordered = [];
  // Named matches first and in their own order -- they are the answer to the
  // question asked. The rest is a fallback, so it is spread rather than served in
  // arrival order.
  for (const c of [...named, ...spreadByCountry(pool)]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    ordered.push(c);
    if (ordered.length >= limit) break;
  }
  return ordered;
}

export const adapter = { name: PROVIDER, category: 'news', fetchAll };
