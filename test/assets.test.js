import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const PUBLIC = new URL('../apps/web/public/', import.meta.url).pathname;
const SOURCES = [
  '../apps/web/src/views/Layout.jsx',
  '../apps/web/src/app.js',
  '../apps/web/public/sw.js',
].map((f) => new URL(f, import.meta.url).pathname);

/** Paths the server answers itself rather than reading straight from public/. */
const ROUTE_SERVED = new Map([
  ['/manifest.webmanifest', null], // generated JSON
  ['/sitemap.xml', null], // generated XML
  ['/favicon.ico', 'icons/favicon.ico'], // root alias for the generated icon
]);

/*
 * Routes served out of a package rather than out of public/.
 *
 * Exempting these would defeat the test: the bug it guards is a path that
 * resolves to nothing. So they are checked the same way, through the module
 * resolver -- if the dependency is dropped or its exports map stops naming the
 * file, this fails exactly as a deleted icon does.
 */
const PACKAGE_SERVED = new Map([
  ['/vendor-multiview.js', '@profullstack/multiview'],
  ['/vendor-multiview.css', '@profullstack/multiview/multiview.css'],
]);

async function referencedPaths() {
  const found = new Set();
  for (const file of SOURCES) {
    const src = await readFile(file, 'utf8');
    for (const m of src.matchAll(
      /["'`](\/(?:icons\/[\w.-]+|[\w-]+\.(?:png|ico|svg|css|js|webmanifest)))["'`]/g,
    )) {
      found.add(m[1]);
    }
    // Icons reached through assetUrl() are spelled without the leading slash, so
    // the pattern above never saw them -- which is most of the icon set, and the
    // whole reason this test exists. A template literal is skipped on purpose:
    // `icons/icon-${s}x${s}.png` is a family, not a path.
    for (const m of src.matchAll(/assetUrl\('(icons\/[\w.-]+)'\)/g)) {
      found.add(`/${m[1]}`);
    }
  }
  return found;
}

/**
 * Every static path the app hands a browser must resolve to something.
 *
 * The bug this guards: icon.svg was deleted but stayed referenced in five places --
 * the favicon link, the manifest, a static route, and the service worker's
 * notification icon and badge. Nothing failed to build, no test broke, and the only
 * symptom was a missing image plus two 404s on every push notification.
 */
describe('static asset references', () => {
  test('every referenced path exists on disk or is served by a known route', async () => {
    const referenced = await referencedPaths();
    expect(referenced.size).toBeGreaterThan(10);

    const missing = [...referenced].filter((p) => {
      if (PACKAGE_SERVED.has(p)) {
        try {
          return !existsSync(Bun.fileURLToPath(import.meta.resolve(PACKAGE_SERVED.get(p))));
        } catch {
          return true;
        }
      }
      if (ROUTE_SERVED.has(p)) {
        const backing = ROUTE_SERVED.get(p);
        return backing !== null && !existsSync(PUBLIC + backing);
      }
      return !existsSync(PUBLIC + p.replace(/^\//, ''));
    });
    expect(missing).toEqual([]);
  });

  test('nothing still points at the deleted icon.svg', async () => {
    for (const file of SOURCES) {
      expect(await readFile(file, 'utf8')).not.toContain('icon.svg');
    }
  });

  test('the header loads a sized icon, never the full-size source image', async () => {
    const layout = await readFile(SOURCES[0], 'utf8');
    // /logo.png is the 2172x724 lockup and /favicon.png the 1254x1254 mark -- the
    // brand art as delivered, about a megabyte each. Linking either from the header
    // would download that on every page to draw a 64px wordmark.
    expect(layout).not.toContain('"/logo.png"');
    expect(layout).not.toContain('"/favicon.png"');
    expect(layout).toContain('class="brand-logo"');

    // Either spelling: a literal src="/icons/x.png", or the versioned
    // src={assetUrl('icons/x.png')} the rest of the head uses. Matching only the
    // first quietly stopped finding the header icon when it moved to the second.
    const headerIcon = /src=(?:"\/icons\/([\w.-]+)"|\{assetUrl\('icons\/([\w.-]+)'\)\})/.exec(
      layout,
    );
    expect(headerIcon).toBeTruthy();
    const { size } = await Bun.file(`${PUBLIC}icons/${headerIcon[1] ?? headerIcon[2]}`).stat();
    expect(size).toBeLessThan(100_000);
  });

  test('the wordmark is gone but the name survives for screen readers', async () => {
    const layout = await readFile(SOURCES[0], 'utf8');
    // The invariant is that the logo carries the site's name as alt text and is
    // not also repeated as a visible wordmark. Asserted against the brand rather
    // than the literal "TipoffWatch", which was one brand's name and made this
    // fail the moment the alt text started naming the site being served.
    expect(layout).toContain('alt={brand.name}');
    expect(layout).not.toContain('<span>{brand.name}</span>');
  });
});
