/**
 * The pit.world global footer (site name, search, ring, publish), fetched on the
 * server from pit.world for this brand's domain and rendered as the last thing
 * in <body>.
 *
 * The Layout renders synchronously, so this keeps the last good copy in a
 * module-level cache and refreshes it in the background once it is an hour old.
 * A failed refresh keeps the old copy; with no copy at all the footer is simply
 * absent, so pit.world being down never breaks a page.
 *
 * The CSP has no 'unsafe-inline' for styles, so the snippet's <style> is lifted
 * out and served from /pit-footer.css, and the markup goes in without it.
 */
import { brand } from '@tipoff/config';
import { raw } from 'hono/html';

const URL = `https://pit.world/snippets/footer.html?site=${encodeURIComponent(brand.domain)}`;
const MAX_AGE_MS = 60 * 60 * 1000;

let latest = { footer: '', css: '' };
let fetchedAt = 0;
let inflight = null;

const refresh = () => {
  inflight ??= fetch(URL, { signal: AbortSignal.timeout(3000) })
    .then(async (res) => {
      if (!res.ok) throw new Error(`pit footer: HTTP ${res.status}`);
      const html = await res.text();
      if (!html.includes('data-pit-footer')) throw new Error('pit footer: unexpected body');
      latest = {
        footer: html.replace(/<style>[\s\S]*?<\/style>/g, '').trim(),
        css: [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n'),
      };
      fetchedAt = Date.now();
    })
    .catch(() => {
      // Keep the last good copy; try again in a minute.
      fetchedAt = Date.now() - MAX_AGE_MS + 60_000;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
};

const refreshIfStale = () => {
  if (Date.now() - fetchedAt > MAX_AGE_MS) refresh();
};

refresh();

/** The footer markup, for the Layout ('' until the first fetch lands). */
export const PitFooter = () => {
  refreshIfStale();
  return raw(latest.footer);
};

/** The snippet's CSS, lifted out of its <style>, for /pit-footer.css. */
export const pitFooterCss = async () => {
  if (!latest.css) await refresh();
  else refreshIfStale();
  return latest.css;
};
