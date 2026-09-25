import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const PAGES = new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname;

/**
 * The follow control on a list row.
 *
 * It exists because of what the site looked like to somebody arriving for the
 * first time: the front page was a list of published stories, every row linked to
 * the story and to its section, and there was no way to follow anything without
 * first clicking through to a section page and finding the button in its header.
 * The hero said "Start following -- it's free" and pointed at a page with nothing
 * to follow on it.
 */
const row = {
  id: 44347,
  state: 'post',
  name: 'Canada prosecutors drop charges against two in Toronto gold heist',
  starts_at: '2026-09-24T23:51:53.000Z',
  time_known: true,
  league_id: 12,
  league_name: 'US news',
  league_slug: 'us-news',
  league_abbr: 'US',
  sport: 'us-news',
  following: false,
  league_following: false,
  home_name: null,
  away_name: null,
  home_score: null,
};

const landing = async (props) => {
  const { Landing } = await import('../apps/web/src/views/pages.jsx');
  return String(await Landing(props).toString());
};

const firstRow = (html) => html.match(/<li class="event[\s\S]*?<\/li>/)?.[0] ?? '';

describe('the follow control on a list row', () => {
  test('a signed-out reader gets a sign-in link that returns to the page', async () => {
    const out = firstRow(await landing({ user: null, today: [row] }));
    expect(out).toContain('class="row-follow"');
    // Named, not a bare "Follow": a mixed list puts a different section on every
    // row, and a column of identical buttons says nothing about what each follows.
    expect(out).toContain('☆ Follow US news');
    expect(out).toContain('href="/login?next=%2F"');
  });

  test('a signed-in reader who follows the section can unfollow it from the row', async () => {
    const out = firstRow(
      await landing({
        user: { id: 'u1' },
        today: [{ ...row, following: true, league_following: true }],
      }),
    );
    expect(out).toContain('action="/api/unfollow"');
    expect(out).toContain('name="subject_type" value="league"');
    expect(out).toContain('name="subject_id" value="12"');
    expect(out).toContain('★ Following US news');
  });

  /*
   * The case the narrower `league_following` flag exists for. A reader who follows
   * one newsroom has a star on the row -- `following` is true -- and has not
   * followed the section. The button must still offer to follow the section, not
   * offer to drop something never picked up.
   */
  test('a row starred through a newsroom still offers to follow the section', async () => {
    const out = firstRow(
      await landing({
        user: { id: 'u1' },
        today: [{ ...row, following: true, league_following: false }],
      }),
    );
    expect(out).toContain('followed-star');
    expect(out).toContain('action="/api/follow"');
    expect(out).toContain('☆ Follow US news');
  });

  test('a row with no section carries no button rather than a broken one', async () => {
    const out = firstRow(await landing({ user: null, today: [{ ...row, league_id: null }] }));
    expect(out).not.toContain('row-follow');
  });

  /*
   * Where it is turned on, asserted against the source rather than by rendering
   * every page.
   *
   * The rule is about the LIST, not the page: a per-row button is worth having
   * where consecutive rows belong to different sections, and is two hundred copies
   * of the page header where they do not. So the front page, the results list and
   * the two browse levels have it; a section's own page and a newsroom's own page
   * must not grow one by someone threading the prop through "for consistency".
   */
  test('only the mixed lists opt in', async () => {
    const src = await readFile(PAGES, 'utf8');
    const bodyOf = (name) => {
      const start = src.indexOf(`export const ${name} = `);
      if (start < 0) throw new Error(`no such page: ${name}`);
      const next = src.indexOf('\nexport const ', start + 10);
      return src.slice(start, next > 0 ? next : undefined);
    };

    for (const name of ['Landing', 'ResultsPage', 'SportsIndex', 'SportPage']) {
      expect({ page: name, optsIn: /\n\s+showFollow\b/.test(bodyOf(name)) }).toEqual({
        page: name,
        optsIn: true,
      });
    }
    for (const name of ['LeaguePage', 'TeamPage', 'Following']) {
      expect({ page: name, optsIn: /\n\s+showFollow\b/.test(bodyOf(name)) }).toEqual({
        page: name,
        optsIn: false,
      });
    }
  });
});
