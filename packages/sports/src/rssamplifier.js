/**
 * Newsrooms, from rssamplifier.com.
 *
 * The third of our own directories, and the one that answers the question this
 * brand is actually named after. rssamplifier indexes 523,547 feeds and
 * classifies each one from its own document on every crawl -- 24,667 of them as
 * `news`, meaning "several articles a day, a staff of bylines, or a masthead
 * that says news, and at least two of those three". That classification is the
 * whole reason this adapter exists: nichedb reads seven world desks plus GDELT
 * domains, brisk reads a wire and the small web, and neither can tell you that a
 * given feed is a newsroom. rssamplifier can, and it says so conservatively --
 * "a blog that posts once a week under one name stays a blog however its masthead
 * reads".
 *
 * HOW A DESK IS ASKED FOR
 *
 * `/topics/{keyword}/news.json` is a JSON Feed of what the news feeds filed
 * under a topic have published, newest first. So a desk here is one request, and
 * the desk name IS the topic -- every one of this brand's sections turned out to
 * exist as a well-covered rssamplifier topic (checked live 2026-09-09: 20 to 57
 * distinct newsrooms each, all publishing the same day). Keywords are
 * normalised upstream, so `sport` and `sports` reach the same document and only
 * one of them needs to be asked for.
 *
 * WHAT IT GIVES THAT THE OTHER TWO DO NOT
 *
 * A real masthead. nichedb and brisk both identify a publisher by bare host, so
 * they produce outlets called `eco-business.com`; this carries `feed_title`, so
 * the same publisher arrives as "Eco-Business", with `feed_page` as somewhere to
 * send a reader who wants to know who that is.
 *
 * TWO THINGS IN THE DOCUMENT THAT MUST NOT BE INGESTED AS NEWS
 *
 * - Sponsored entries. rssamplifier inserts one every ten items, at most three
 *   per document, and its own documentation says to filter them if you are
 *   indexing. They are OUR ads -- crawlproof.com placements -- and they are
 *   stamped with the day they were served, so ingesting them would put a house
 *   advert on the front page every single sync. Note the item count: asking for
 *   200 returns 203, because the sponsored entries ride on top of the limit
 *   rather than inside it.
 * - Future dates. A publisher that files a release date as a post date lands
 *   here unclamped -- a games feed on the `sport` desk was dated six days out.
 *   This brand stores a story as `post`, and the home page asks for today, so a
 *   future-dated row is filed on a day that has not happened and shows up
 *   nowhere a reader looks.
 */

import { decodeEntities } from './entities.js';
import { getJson } from './http.js';
import { boundedKeyFor, keyFor, slugify } from './slug.js';

const BASE = 'https://rssamplifier.com';
const PROVIDER = 'rssamplifier';

/**
 * The discriminator for slugs, and why it is not the provider name.
 *
 * `slugify(text, discriminator)` keeps only the LAST EIGHT characters of the
 * discriminator -- the same trap that turned Al Jazeera into
 * `al-jazeera-ljazeera` for nichedb. 'rssamplifier' truncates to 'mplifier',
 * so every outlet here would read `eco-business-mplifier`. Three letters
 * survive intact and no other provider produces them.
 */
const TAG = 'rsa';

/**
 * The desks this adapter fills, which are also the topics it asks for.
 *
 * Every one was verified to exist as a news topic with same-day items. Not
 * `independent`: that is the small web, which is a category rssamplifier keeps
 * apart from news on purpose, and brisk already carries it.
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
  'entertainment',
  'food',
  'travel',
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
};

/** These must agree with the other news adapters, or one desk sorts two ways. */
const SECTION_PRIORITY = { world: 10, us: 20, politics: 30, business: 40 };
const DEFAULT_PRIORITY = 100;

/** The documented ceiling. Fifty by default, 200 the most it will serve. */
const PAGE = 200;

/**
 * How far ahead of us a publisher's clock is allowed to be.
 *
 * Feeds routinely file a post a few minutes ahead through timezone sloppiness,
 * and rejecting those would drop real stories. A date days out is not skew, it
 * is a release date in a `published` field.
 */
const SKEW_MS = 15 * 60 * 1000;

/**
 * Is this entry an advert rather than a story?
 *
 * Checked three ways because the document says two and the live payload showed a
 * third: the `_crawlproof` extension object, a `Sponsored` tag, and the
 * `tag:crawlproof.com,...:ad/...` id. Any one of them is enough. Getting this
 * wrong does not fail loudly -- it publishes a house advert as the day's news.
 */
export function isSponsored(item) {
  if (!item) return false;
  if (item._crawlproof) return true;
  if ((item.tags ?? []).some((t) => String(t).toLowerCase() === 'sponsored')) return true;
  return /^tag:crawlproof\.com/i.test(String(item.id ?? ''));
}

/**
 * The newsroom that published a story, as {key, name, url}.
 *
 * `feed_page` ends in rssamplifier's own slug for the feed, which is stable
 * across crawls and unique per feed -- two publications sharing a name (and they
 * do; the directory has eight `eco-business-com-*`) stay two outlets. The title
 * is what a reader should see.
 */
export function outletOf(item) {
  const meta = item?._rssamplifier ?? {};
  const page = typeof meta.feed_page === 'string' ? meta.feed_page.trim() : '';
  const name = masthead(meta.feed_title);
  if (!name) return null;
  const slug = page.split('/').filter(Boolean).pop() ?? '';
  // The feed slug is the identity; without one the title has to serve, folded so
  // the same masthead does not arrive twice over a capital letter.
  return { key: slug || name.toLowerCase(), name, url: page || null };
}

/**
 * A feed's <title> reduced to the name of the publication.
 *
 * A masthead here is whatever the publisher put in their feed document, and a
 * good many of them are the name followed by a tagline:
 * "Al Jazeera – Breaking News, World News and Video from Al Jazeera". Carried
 * whole, that is the outlet name on every card and in the follow list.
 *
 * Only long titles are cut, and only at a separator the publisher wrote. That
 * length rule is doing real work: "News - Tennisuptodate.com" and
 * "Daily Express :: World Feed" both have a separator and a useless left-hand
 * side, and both survive intact because they are short enough not to be a name
 * plus a sales pitch.
 */
const SEPARATORS = /\s+(?:[|\u2013\u2014:]|::|-)\s+/;
const LONG = 40;

export function masthead(title) {
  const full = decodeEntities(title);
  if (!full) return null;
  if (full.length <= LONG) return full;
  const [head] = full.split(SEPARATORS);
  const name = head?.trim();
  return name && name.length >= 3 && name.length <= LONG ? name : full.slice(0, 120).trim();
}

/**
 * The URL an outlet lives at.
 *
 * Built from the feed slug rather than the masthead, which a live pass insisted
 * on: mastheads repeat. The directory holds eight feeds titled "Eco-Business",
 * and 393 outlets in one pass produced a duplicate slug. `teams.slug` is NOT
 * NULL UNIQUE while `upsertTeams` conflicts on `(provider, provider_key)`, so
 * two rows racing for one slug is a unique violation that aborts the whole batch
 * -- every good row in the pass lost, not just the clashing pair. The feed slug
 * is unique upstream, so it cannot collide with itself; the masthead is still
 * what a reader sees, as the name.
 *
 * Discriminated as well, like brisk's and unlike nichedb's, so it cannot collide
 * with the same publisher carried by another provider.
 */
export function outletSlug(outlet) {
  return slugify(outlet.key, TAG);
}

/** One desk's river, newest first. */
async function river(topic, { limit = PAGE } = {}) {
  const url = `${BASE}/topics/${encodeURIComponent(topic)}/news.json?limit=${limit}`;
  const res = await getJson(url, { timeoutMs: 45_000 });
  return res?.items ?? [];
}

/**
 * Turn one desk's items into catalogue rows, accumulating into the maps.
 *
 * Exported so the filtering can be tested without the network -- it is the only
 * part of this adapter with any decisions in it.
 */
export function collect(items, { desks, outlets, events, seen = new Set(), section, now } = {}) {
  if (!section) return;
  const ceiling = (now ?? Date.now()) + SKEW_MS;

  for (const it of items ?? []) {
    // A house advert, stamped with today's date. See the note at the top.
    if (isSponsored(it)) continue;
    if (!it?.title || !it.url) continue;

    // The same story is filed under several topics -- a climate story is also a
    // science story -- so one pass sees it more than once. It keeps the first
    // desk that claimed it rather than being written twice.
    if (seen.has(it.url)) continue;

    const publishedAt = it.date_published ? new Date(it.date_published) : null;
    if (!publishedAt || Number.isNaN(publishedAt.getTime())) continue;
    // A release date in a published field. Dropped rather than clamped to now,
    // which would announce a game six days out as this morning's news.
    if (publishedAt.getTime() > ceiling) continue;

    const outlet = outletOf(it);
    if (!outlet) continue;

    // Nothing upstream decodes these, and JSX escapes on the way out, so an
    // undecoded headline reaches the reader as the entity itself.
    const title = decodeEntities(it.title);
    if (!title) continue;

    seen.add(it.url);

    const deskKey = keyFor(PROVIDER, 'desk', section);
    if (!desks.has(deskKey)) {
      desks.set(deskKey, {
        provider: PROVIDER,
        providerKey: deskKey,
        category: section,
        // `leagues.slug` is UNIQUE as well, and nichedb already owns
        // `world-news` while brisk owns `world-news-brisk`.
        slug: slugify(`${section}-news`, TAG),
        name: SECTION_NAMES[section] ?? section,
        priority: SECTION_PRIORITY[section] ?? DEFAULT_PRIORITY,
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
        // Somewhere to send a reader who wants to know who this is -- the one
        // thing the host-derived outlets on the other two adapters cannot offer.
        url: outlet.url,
        genreKeys: [],
      });
    }
    // A newsroom covers several desks, so its set accumulates.
    const row = outlets.get(outletKey);
    if (!row.genreKeys.includes(deskKey)) row.genreKeys.push(deskKey);

    events.push({
      provider: PROVIDER,
      providerKey: boundedKeyFor([PROVIDER, 'story', it.url]),
      category: section,
      subjectKey: outletKey,
      kind: 'story',
      startsAt: publishedAt,
      timeKnown: true,
      precision: 'minute',
      // Published, not scheduled -- the tense problem nichedb documents.
      state: 'out',
      name: title,
      shortName: null,
      summary: decodeEntities(it.summary ?? null),
      imageUrl: typeof it.image === 'string' && it.image ? it.image : null,
      // The publisher's own link. `readUrl` would send a reader to a reader view
      // on somebody else's site, which is not what "know who reported it" means.
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
 * Recent stories from the newsrooms rssamplifier has classified, by desk.
 *
 * One request per desk, sequential -- twelve of them, and `getJson` already
 * paces per host. There is no offset on a topic river, so 200 an ask is the
 * ceiling and the interval is what decides how much history accumulates.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.sections] Desks to fetch. Defaults to all of them.
 * @param {number} [opts.limit] Items per desk, 200 being the documented maximum.
 */
export async function fetchAll({ sections = SECTIONS, limit = PAGE } = {}) {
  const desks = new Map();
  const outlets = new Map();
  const events = [];
  const seen = new Set();
  const now = Date.now();

  for (const section of sections) {
    /*
     * A desk that has nothing under it is a 404 here rather than an empty
     * document, and one missing topic is not a reason to lose the other eleven.
     */
    try {
      const items = await river(section, { limit });
      collect(items, { desks, outlets, events, seen, section, now });
    } catch {
      // Counted by its absence from the result; the sync log reports the totals.
    }
  }

  return { genres: [...desks.values()], subjects: [...outlets.values()], events };
}

export const adapter = { name: PROVIDER, category: 'world', fetchAll };
