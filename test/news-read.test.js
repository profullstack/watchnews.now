import { beforeAll, describe, expect, test } from 'bun:test';

let out;
let sports;
beforeAll(async () => {
  const probe = new URL('./fixtures/news-read-probe.js', import.meta.url).pathname;
  const run = async (brand) => {
    const child = Bun.spawn(['bun', probe], {
      env: { ...process.env, BRAND: brand },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout.trim().split('\n').at(-1));
  };
  out = await run('watchnews');
  sports = await run('tipoffwatch');
}, 60_000);

describe('the public news reading flow', () => {
  test('the home page shows recent stories even when today has none', () => {
    expect(out.brand).toBe('watchnews');
    expect(out.home).toContain('Latest world story');
    expect(out.home).toContain('Older world story');
    expect(out.home.indexOf('Latest world story')).toBeLessThan(
      out.home.indexOf('Older world story'),
    );
    expect(out.home).not.toContain('Future-dated story');
    expect(out.home).not.toContain('Archived story');
    expect(out.home).not.toContain('Today fixture');
    expect(out.home).not.toContain('No games scheduled');
    expect(out.home).toContain('Browse all recent stories');
  });

  test('article lists use publication labels and news metadata', () => {
    expect(out.latest).toContain('Published');
    expect(out.latest).not.toContain('>Final<');
    expect(out.latest).not.toContain('Final scores');
    expect(out.empty).toContain('Nothing published in the last week');
  });

  test('a section points directly to its latest coverage', () => {
    expect(out.section).toContain('href="/results?sport=world"');
    expect(out.section).toContain('Follow section');
    expect(out.section).not.toContain('Follow league');
  });

  test('the events API returns recent published stories with publisher links', () => {
    expect(out.api.events.map((event) => Number(event.id))).toEqual([2, 3, 1]);
    expect(out.api.events[0].url).toBe('https://publisher.example/latest');
    expect(out.api.events[0].summary).toBe('A recent summary.');
    expect(out.filtered.count).toBe(1);
    expect(Number(out.filtered.events[0].id)).toBe(2);
    expect(JSON.stringify(out.docs.endpoints)).toContain('Published stories');
  });

  test('the forward-facing public feed still returns upcoming events', () => {
    expect(out.future.map((event) => Number(event.id))).toEqual([7, 4, 6]);
    expect(sports.api.events.map((event) => Number(event.id))).toEqual([7, 4, 6]);
    expect(sports.home).toContain('Today fixture');
    expect(sports.home).not.toContain('Latest world story');
    expect(sports.latest).toContain('>Final<');
  });

  test('About identifies WatchNews and the real public sources', () => {
    expect(out.about).toContain('About WatchNews');
    expect(out.about).toContain('https://nichedb.dev/c/news');
    expect(out.about).toContain('GDELT');
    expect(out.about).not.toContain('About TipoffWatch');
    expect(out.about).not.toContain('ESPN');
    expect(out.about).not.toContain('upcoming fixtures');
  });
});
