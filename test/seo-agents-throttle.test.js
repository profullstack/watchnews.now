import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { isSeoAgent, robotsTxt, SEO_AGENTS } = await import('../apps/web/src/lib/well-known.js');
const APP = new URL('../apps/web/src/app.js', import.meta.url).pathname;

// The exact strings from the access log on 2026-10-19.
const DATAFORSEO = 'Mozilla/5.0 (compatible; DataForSeoBot/1.0; +https://dataforseo.com/dataforseo-bot)';
const AHREFS = 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const PETAL =
  'Mozilla/5.0 (Linux; Android 7.0;) AppleWebKit/537.36 (HTML, like Gecko) Mobile Safari/537.36 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)';
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

describe('SEO data crawlers', () => {
  test('are recognised by the user agent they actually send', () => {
    expect(isSeoAgent(DATAFORSEO)).toBe(true);
    expect(isSeoAgent(AHREFS)).toBe(true);
  });

  test('search engines and readers are not among them', () => {
    // A search engine sends readers back; that is the whole line being drawn.
    expect(isSeoAgent(GOOGLEBOT)).toBe(false);
    expect(isSeoAgent(PETAL)).toBe(false);
    expect(isSeoAgent(CHROME)).toBe(false);
    expect(isSeoAgent()).toBe(false);
  });

  test('robots.txt charges every one of them, with the sales page left open', () => {
    const out = robotsTxt();
    for (const agent of SEO_AGENTS) {
      expect(out).toContain(`User-agent: ${agent}\nDisallow: /\nAllow: /crawl`);
    }
  });

  test('and still charges the training crawlers it did before', () => {
    expect(robotsTxt()).toContain('User-agent: GPTBot\nDisallow: /\nAllow: /crawl');
  });
});

describe('the throttle', () => {
  test('runs after the crawl gateway and before the session lookup', async () => {
    // Before the gateway, a declared crawler would be counted instead of
    // charged; after the session lookup, every metered request would cost a
    // database read the refusal does not need.
    const src = await readFile(APP, 'utf8');
    const gateway = src.indexOf('await crawlGateway.handle(');
    const throttle = src.indexOf('await throttle.handle(');
    const session = src.indexOf('auth.userFromRequest(sid)');
    expect(gateway).toBeGreaterThan(-1);
    expect(throttle).toBeGreaterThan(gateway);
    expect(session).toBeGreaterThan(throttle);
  });

  test('sells through the same gateway rather than answering a bare 429', async () => {
    const src = await readFile(APP, 'utf8');
    expect(src).toMatch(/createThrottle\(\{\s*gateway: crawlGateway/);
  });
});
