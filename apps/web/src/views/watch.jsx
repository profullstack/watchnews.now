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

export const WatchIndex = ({ user, channels, groups = [] }) => (
  <Layout
    title="Watch the news"
    user={user}
    canonical="/watch"
    description={`Live news channels you can watch in the page, free and without an account. ${brand.name}.`}
  >
    <h1>Watch</h1>
    <p class="muted">
      Live news channels, playing here rather than somewhere else. No account, and nothing to
      install.
    </p>

    {/*
      Grouped by where each channel broadcasts from, biggest group first.

      A flat list answered "is there anything from Germany" only by reading all of
      it -- and because the directory is not evenly spread, the top of that list was
      one country's regional desks over and over. The groups say what the coverage
      actually is, which is the honest version of this page.
    */}
    {groups.length > 0 ? (
      groups.map((g) => (
        <ChannelList
          channels={g.channels}
          heading={g.country ? countryName(g.country) : 'Elsewhere'}
        />
      ))
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
