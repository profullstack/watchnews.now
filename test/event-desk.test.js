import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * Which collection an event is filed under when its subject spans several.
 *
 * `genreKeys[0]` is right for a subject whose collections share one category: a
 * show belongs to several genres and an episode belongs to the show, so any of
 * them will do.
 *
 * It is wrong for a subject that spans categories, which is exactly what a news
 * outlet does. A publisher covering world and US news has both desks, and every
 * story it filed was landing on whichever desk came first. Seen live right after
 * consolidating onto one provider: the US and technology desks listed outlets
 * and not a single story, because their publishers were filed under world first.
 *
 * This reproduces the selection ingest makes, against both shapes.
 */
const pick = (subject, event, genres) => {
  const byKey = new Map(genres.map((g) => [g.providerKey, g]));
  const own = subject.genreKeys.find((k) => byKey.get(k)?.category === event.category);
  return own ?? subject.genreKeys[0];
};

describe('a subject that spans categories', () => {
  const desks = [
    { providerKey: 'nichedb:beat:world', category: 'world' },
    { providerKey: 'nichedb:beat:us', category: 'us' },
    { providerKey: 'nichedb:beat:technology', category: 'technology' },
  ];
  // A publisher covering all three, world seen first.
  const outlet = {
    genreKeys: ['nichedb:beat:world', 'nichedb:beat:us', 'nichedb:beat:technology'],
  };

  test('a story is filed under its own desk, not its publisher first one', () => {
    expect(pick(outlet, { category: 'us' }, desks)).toBe('nichedb:beat:us');
    expect(pick(outlet, { category: 'technology' }, desks)).toBe('nichedb:beat:technology');
    expect(pick(outlet, { category: 'world' }, desks)).toBe('nichedb:beat:world');
  });

  test('a desk the publisher does not cover falls back rather than orphaning', () => {
    // league_id is NOT NULL and an unresolved key is counted as orphaned, so a
    // fallback keeps the story rather than dropping it.
    expect(pick(outlet, { category: 'food' }, desks)).toBe('nichedb:beat:world');
    expect(pick(outlet, { category: undefined }, desks)).toBe('nichedb:beat:world');
  });
});

/**
 * The other shape, unchanged. tvmaze writes every genre with category 'tv', so
 * matching within the subject's own genres returns the first one -- exactly what
 * it returned before.
 */
describe('a subject whose collections share a category', () => {
  const genres = [
    { providerKey: 'tvmaze:genre:drama', category: 'tv' },
    { providerKey: 'tvmaze:genre:scifi', category: 'tv' },
  ];
  const show = { genreKeys: ['tvmaze:genre:drama', 'tvmaze:genre:scifi'] };

  test('an episode still lands on the first genre', () => {
    expect(pick(show, { category: 'tv' }, genres)).toBe('tvmaze:genre:drama');
  });

  test('and does so however many genres the show has', () => {
    const many = { genreKeys: [...show.genreKeys, 'tvmaze:genre:comedy'] };
    const all = [...genres, { providerKey: 'tvmaze:genre:comedy', category: 'tv' }];
    expect(pick(many, { category: 'tv' }, all)).toBe('tvmaze:genre:drama');
  });
});
