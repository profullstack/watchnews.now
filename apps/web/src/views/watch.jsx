import { brand } from '@tipoff/config';
import { assetUrl } from '../lib/asset-version.js';
import { Layout } from './Layout.jsx';

/**
 * Watching a news channel.
 *
 * The rest of this site answers "when is it on" and then "where can I watch
 * it". News has no answer to the first and a strange answer to the second: you
 * cannot tune in to an article. What you can do is watch the desk -- so a
 * channel page is its own destination here rather than something hanging off an
 * event, and every section and outlet page links into it.
 */

const label = (c) => [c.country, c.quality].filter(Boolean).join(' · ');

export const ChannelList = ({ channels, heading, blurb }) =>
  channels.length === 0 ? null : (
    <section class="channels">
      <h2>{heading}</h2>
      {blurb ? <p class="muted">{blurb}</p> : null}
      <ul class="leagues">
        {channels.map((c) => (
          <li>
            <a href={`/watch/${c.id}`}>
              <strong>{c.name}</strong>
              {label(c) ? <span class="muted">{label(c)}</span> : null}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );

/**
 * Country codes to names, for the ones the directory actually carries.
 *
 * Not a full ISO table: this is a heading on a page, and a two-letter code is a
 * worse heading than a name for exactly the countries somebody is scanning for.
 * Anything unlisted falls back to the code, which is still better than nothing.
 */
const COUNTRY_NAME = {
  AF: 'Afghanistan',
  AL: 'Albania',
  AM: 'Armenia',
  AZ: 'Azerbaijan',
  BA: 'Bosnia and Herzegovina',
  BF: 'Burkina Faso',
  BG: 'Bulgaria',
  BJ: 'Benin',
  BO: 'Bolivia',
  BS: 'Bahamas',
  BY: 'Belarus',
  BZ: 'Belize',
  CD: 'DR Congo',
  CI: "Côte d'Ivoire",
  CM: 'Cameroon',
  CR: 'Costa Rica',
  CU: 'Cuba',
  CY: 'Cyprus',
  DO: 'Dominican Republic',
  DZ: 'Algeria',
  EC: 'Ecuador',
  ET: 'Ethiopia',
  GE: 'Georgia',
  GN: 'Guinea',
  GT: 'Guatemala',
  HK: 'Hong Kong',
  HN: 'Honduras',
  HR: 'Croatia',
  HT: 'Haiti',
  IS: 'Iceland',
  JO: 'Jordan',
  KG: 'Kyrgyzstan',
  KH: 'Cambodia',
  KW: 'Kuwait',
  KZ: 'Kazakhstan',
  LA: 'Laos',
  LB: 'Lebanon',
  LT: 'Lithuania',
  LY: 'Libya',
  MA: 'Morocco',
  MC: 'Monaco',
  MD: 'Moldova',
  MK: 'North Macedonia',
  MM: 'Myanmar',
  MN: 'Mongolia',
  MO: 'Macau',
  MT: 'Malta',
  MV: 'Maldives',
  NE: 'Niger',
  NI: 'Nicaragua',
  OM: 'Oman',
  PA: 'Panama',
  PE: 'Peru',
  PR: 'Puerto Rico',
  PS: 'Palestine',
  PY: 'Paraguay',
  SD: 'Sudan',
  SK: 'Slovakia',
  SN: 'Senegal',
  SV: 'El Salvador',
  SY: 'Syria',
  TG: 'Togo',
  UK: 'United Kingdom',
  UZ: 'Uzbekistan',
  VE: 'Venezuela',
  XK: 'Kosovo',
  YE: 'Yemen',
  AE: 'United Arab Emirates',
  AR: 'Argentina',
  AT: 'Austria',
  AU: 'Australia',
  BD: 'Bangladesh',
  BE: 'Belgium',
  BR: 'Brazil',
  CA: 'Canada',
  CH: 'Switzerland',
  CL: 'Chile',
  CN: 'China',
  CO: 'Colombia',
  CZ: 'Czechia',
  DE: 'Germany',
  DK: 'Denmark',
  EG: 'Egypt',
  ES: 'Spain',
  FI: 'Finland',
  FR: 'France',
  GB: 'United Kingdom',
  GR: 'Greece',
  HU: 'Hungary',
  ID: 'Indonesia',
  IE: 'Ireland',
  IL: 'Israel',
  IN: 'India',
  IQ: 'Iraq',
  IR: 'Iran',
  IT: 'Italy',
  JP: 'Japan',
  KE: 'Kenya',
  KR: 'South Korea',
  MX: 'Mexico',
  MY: 'Malaysia',
  NG: 'Nigeria',
  NL: 'Netherlands',
  NO: 'Norway',
  NZ: 'New Zealand',
  PH: 'Philippines',
  PK: 'Pakistan',
  PL: 'Poland',
  PT: 'Portugal',
  QA: 'Qatar',
  RO: 'Romania',
  RS: 'Serbia',
  RU: 'Russia',
  SA: 'Saudi Arabia',
  SE: 'Sweden',
  SG: 'Singapore',
  TH: 'Thailand',
  TR: 'Turkey',
  TW: 'Taiwan',
  UA: 'Ukraine',
  US: 'United States',
  VN: 'Vietnam',
  ZA: 'South Africa',
};

export const countryName = (code) => COUNTRY_NAME[String(code).toUpperCase()] ?? code;

export const WatchIndex = ({
  user,
  channels,
  sample = [],
  index = [],
  total = 0,
  countries = 0,
  q = null,
}) => (
  <Layout
    title="Watch the news"
    user={user}
    canonical="/watch"
    description={`Live news channels you can watch in the page, free and without an account. ${brand.name}.`}
  >
    <h1>Watch the news live</h1>
    <p class="muted">
      {total > 0
        ? `${total.toLocaleString('en-US')} live channels from ${countries.toLocaleString('en-US')} countries, playing here rather than somewhere else. No account, and nothing to install.`
        : 'Live news channels, playing here rather than somewhere else. No account, and nothing to install.'}
    </p>

    {/*
      Find by name first.

      With a thousand channels, somebody who knows what they want -- "France 24",
      "NHK" -- is served by one box far better than by any hierarchy, and a reader
      who does not know what they want has the regions below. Both, in that order,
      because the first is one line and the second is the rest of the page.
    */}
    <search class="watch-search">
      <form method="get" action="/watch">
        <label class="sr-only" for="watch-q">
          Search channels
        </label>
        <input
          id="watch-q"
          type="search"
          name="q"
          value={q ?? ''}
          placeholder="Find a channel by name"
          autocomplete="off"
          enterkeyhint="search"
        />
        <button type="submit" class="ghost">
          Search
        </button>
      </form>
    </search>

    {q ? (
      <ChannelList
        channels={channels}
        heading={`Matching "${q}"`}
        blurb={channels.length === 0 ? undefined : 'Closest names first.'}
      />
    ) : null}
    {q && channels.length === 0 ? (
      <p class="empty">Nothing here is called that. Try a region below.</p>
    ) : null}

    {/*
      A sample, then the map.

      This page used to render all of them, which was 963 rows and 113KB, and it
      ordered the groups by size -- so a reader landed on one country's 256 regional
      desks and had to scroll past every one of them. Size was never what anybody
      was looking for.

      The sample is one channel per country (see spreadByCountry), so the top of the
      page is a spread by construction rather than by luck. The regions are the way
      in for somebody who wants a particular part of the world, alphabetical at both
      levels so nothing "wins".
    */}
    {!q ? <ChannelList channels={sample} heading="On now" blurb="A few from around the world." /> : null}

    {index.length > 0 ? (
      <section class="channels regions">
        <h2>Browse by country</h2>
        <p class="muted">Every country the directory carries, with how many channels each has.</p>
        {index.map((r) => (
          <div class="region">
            <h3>
              {r.region} <span class="muted num">{r.total.toLocaleString('en-US')}</span>
            </h3>
            <p class="chips">
              {r.countries.map((c) => (
                <a class="chip" href={`/watch/country/${c.code.toLowerCase()}`}>
                  {countryName(c.code)} <span class="muted">{c.count}</span>
                </a>
              ))}
            </p>
          </div>
        ))}
      </section>
    ) : null}
  </Layout>
);

/**
 * One country's channels, on a URL of their own.
 *
 * A path rather than a query string, because this is a page worth being indexed and
 * linked: "live news channels from Ukraine" is a thing people search for, and a
 * facet buried in ?country= is a page search engines treat as a duplicate of the
 * index.
 */
export const WatchCountry = ({ user, code, channels }) => (
  <Layout
    title={`Live news channels from ${countryName(code)}`}
    user={user}
    canonical={`/watch/country/${String(code).toLowerCase()}`}
    description={`${channels.length} live news channels from ${countryName(code)}, playing in the page. Free, and no account needed. ${brand.name}.`}
  >
    <ol class="crumbs" aria-label="Breadcrumb">
      <li>
        <a href="/watch">Watch</a>
      </li>
      <li aria-current="page">{countryName(code)}</li>
    </ol>
    <h1>{countryName(code)}</h1>
    <p class="muted">
      {channels.length.toLocaleString('en-US')} live channel
      {channels.length === 1 ? '' : 's'}, playing in the page.
    </p>
    {channels.length === 0 ? (
      <p class="empty">
        Nothing from there yet. <a href="/watch">Every country we do carry</a>.
      </p>
    ) : (
      <ChannelList channels={channels} heading="On now" />
    )}
  </Layout>
);

export const WatchChannel = ({ user, channel, also }) => (
  <Layout
    title={`${channel.name} live`}
    user={user}
    canonical={`/watch/${channel.id}`}
    description={`Watch ${channel.name} live${channel.country ? ` from ${channel.country}` : ''}, free and in the page.`}
  >
    <ol class="crumbs" aria-label="Breadcrumb">
      <li>
        <a href="/watch">Watch</a>
      </li>
      <li aria-current="page">{channel.name}</li>
    </ol>
    <h1>{channel.name}</h1>

    {/* The house player draws its own control bar into this element, and picks
        its own engine. It is the same @profullstack/player the radio bar and the
        codec table come from, so there is one engine ladder on this site rather
        than two that drift -- which is exactly what the hand-rolled hls.js
        player this replaced had started. */}
    <div class="player">
      <div id="channel-stage" data-src={`/watch/${channel.id}/index.m3u8`} />
      <p class="muted" data-player-note>
        Starting…
      </p>
      {/* The same playlist the player above is reading, for a player that is not
          this page. Nothing here is a credential: /watch/:id/index.m3u8 is a
          public route that takes no session, so the address in the clipboard
          works in VLC, mpv or a set-top box exactly as it works here. Written as
          a path and made absolute by app.js, because only the browser knows
          which of the sibling brands it is on. */}
      <p class="player-copy">
        <button
          type="button"
          class="ghost small-btn copy-url-btn"
          data-copy-url={`/watch/${channel.id}/index.m3u8`}
        >
          Copy URL
        </button>
        <span class="muted small">Paste it into VLC, mpv, or anything that plays HLS.</span>
      </p>
    </div>

    <p class="muted">
      {[channel.network, channel.country, channel.quality].filter(Boolean).join(' · ')}
      {channel.website ? (
        <>
          {' · '}
          <a href={channel.website} rel="noopener nofollow">
            Official site
          </a>
        </>
      ) : null}
    </p>
    <p class="muted">
      Streamed from the channel's own public feed. {brand.name} does not host it, and a channel that
      stops working here has usually stopped working at the source.
    </p>

    <ChannelList channels={also} heading="Also on" />
    <link rel="stylesheet" href={assetUrl('vendor-player.css')} />
    <script src={assetUrl('vendor-watch.js')} defer />
  </Layout>
);
