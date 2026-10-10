/**
 * The shared Profullstack footer (@profullstack/footer): the small link row, the
 * copyright line and the webring, from the package's @latest template, so a
 * release of the package reaches this site without a redeploy.
 *
 * The Layout renders synchronously, so this keeps the last rendered footer and
 * refreshes it in the background on each use (the package itself caches the
 * template for an hour). Until the first refresh lands it is the template that
 * shipped in the installed package.
 *
 * The CSP has no 'unsafe-inline' for styles, so the footer is rendered without
 * its inline <style> and the same CSS is served from /pfs-footer.css instead.
 */
import { footerHtml, footerHtmlSync } from '@profullstack/footer';
import { brand, href } from '@tipoff/config';
import { raw } from 'hono/html';

const options = {
  site: `https://${brand.domain}/`,
  links: [
    { label: brand.words.browse, href: href.category() },
    { label: 'About', href: '/about' },
    { label: 'RSS & calendars', href: '/feeds' },
    { label: 'Public API', href: '/api/v1' },
    { label: 'Contact', href: '/contact' },
    { label: 'Privacy', href: '/privacy' },
    { label: 'Terms', href: '/terms' },
  ],
};

const styleOf = (html) => /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';

const initial = footerHtmlSync(options);
let latest = { footer: footerHtmlSync({ ...options, css: false }), css: styleOf(initial) };

const refresh = () =>
  footerHtml(options)
    .then((html) => {
      latest = { footer: html.replace(/<style>[\s\S]*?<\/style>/, ''), css: styleOf(html) };
    })
    .catch(() => {});

/** The footer element, for the Layout. */
export const PfsFooter = () => {
  refresh();
  return raw(latest.footer);
};

/** The template's CSS, as the package sanitized it, lifted out of its <style>. */
export const pfsFooterCss = async () => {
  await refresh();
  return latest.css;
};
