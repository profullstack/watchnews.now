import { config } from '@tipoff/config';
import { sql } from '@tipoff/db';
import * as q from '@tipoff/db/queries';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it blocks on, or
 * a blocking read that outlives the retry budget kills the worker. Sharing one
 * connection object across queues keeps the socket count flat as queues are added.
 */
export const connection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const QUEUES = {
  /** Fixture ingestion from the sports providers. */
  sync: 'sync',
  /** Ticks every 30s and asks "what crosses a reminder threshold right now?" */
  scan: 'reminder-scan',
  /** One job per (event, offset). Pages followers into batch jobs. */
  fanout: 'reminder-fanout',
  /** One job per page of followers. Claims and sends. */
  batch: 'reminder-batch',
  /** Refreshes scores for whatever is being played right now. */
  live: 'live-scores',
  /** Pulls play-by-play for games in progress. */
  plays: 'live-plays',
  /** Re-fetches readers' own channel lists from their providers. */
  playlists: 'playlist-refresh',
  /** Takes down managed lists whose live TV pass has lapsed. Down only. */
  livePasses: 'live-pass-reconcile',
};

const defaults = {
  removeOnComplete: { age: 3600, count: 5000 },
  removeOnFail: { age: 86400 },
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
};

export const queues = Object.fromEntries(
  Object.entries(QUEUES).map(([k, name]) => [
    k,
    new Queue(name, { connection, defaultJobOptions: defaults }),
  ]),
);

/**
 * The recurring jobs, as BullMQ job schedulers: `[queue, id, repeat, name, data]`.
 *
 * BullMQ 6 dropped repeatable jobs: `add(name, data, { repeat })` no longer
 * schedules anything, and getRepeatableJobs/removeRepeatableByKey are gone.
 * Job schedulers (upsertJobScheduler) are the replacement, and exist in 5.x too.
 *
 * - live-passes: lapsed passes come down within the grace window plus a quarter
 *   of an hour. Cheap: one query that is usually empty.
 * - scan: a 1-minute reminder needs sub-minute resolution to land on time.
 * - live: scores. Only leagues with a game actually in progress are fetched, so
 *   this is a handful of requests a minute rather than a sweep -- without it a
 *   live score is as stale as the last full sync, which was measured at 69 minutes.
 * - plays: slower than scores on purpose: a summary is ~500KB against a
 *   scoreboard's few KB, and every one goes through the metered proxy.
 * - playlists: readers' own channel lists. The provider rewrites its numbered
 *   event slots close to kickoff, so a list imported an hour ago has the wrong
 *   titles by the time the game starts. There is no cheap poll to lean on (a full
 *   200 on If-Modified-Since, no ETag), so each list carries its own
 *   refresh_after and this tick only picks up what is genuinely due. This line
 *   once went missing in a rebase and nothing noticed: a consumer with no
 *   producer is silent, not broken.
 * - sync-near: tonight and tomorrow, for the leagues that actually have a game
 *   then. Measured 2026-08-21: 74 of 359 leagues, about a tenth of a full sweep,
 *   so it can run often enough to catch a postponement hours before kickoff.
 * - sync-all / sync-catalogue: the whole catalogue and the full horizon, once a
 *   day. The expensive one -- two requests per league across 359 leagues.
 */
export function scheduleSpecs() {
  return [
    [queues.livePasses, 'live-passes', { every: 15 * 60_000 }, 'live-pass-reconcile', {}],
    [queues.scan, 'scan', { every: 30_000 }, 'scan', {}],
    [queues.live, 'live', { every: 60_000 }, 'live-scores', {}],
    [queues.plays, 'plays', { every: 120_000 }, 'live-plays', {}],
    [
      queues.playlists,
      'playlists',
      { every: Math.max(1, config.playlists.refreshMinutes) * 60_000 },
      'playlist-refresh',
      {},
    ],
    [queues.sync, 'sync-near', { every: 3 * 3600_000 }, 'sync-near', { kind: 'near' }],
    [queues.sync, 'sync-all', { every: 24 * 3600_000 }, 'sync-all', { kind: 'all' }],
    [
      queues.sync,
      'sync-catalogue',
      { every: 24 * 3600_000 },
      'sync-catalogue',
      { kind: 'catalogue' },
    ],
  ];
}

/**
 * Schedules are declared, not accumulated: every scheduler the code does not
 * name is removed on boot (which also clears 5.x repeatables left in Redis),
 * and the rest are upserted, so the code is the single source of truth.
 */
export async function installSchedules({ log = console.log } = {}) {
  const specs = scheduleSpecs();
  for (const q of [
    queues.scan,
    queues.sync,
    queues.live,
    queues.plays,
    queues.playlists,
    queues.livePasses,
  ]) {
    const wanted = new Set(specs.filter(([sq]) => sq === q).map(([, id]) => id));
    for (const s of await q.getJobSchedulers()) {
      const id = s.id ?? s.key;
      if (id && !wanted.has(id)) await q.removeJobScheduler(id);
    }
  }
  for (const [q, id, repeat, name, data] of specs) {
    await q.upsertJobScheduler(id, repeat, { name, data });
  }

  // Two problems solved by the same check.
  //
  // First, a scheduled job runs one interval from NOW, not immediately -- so a
  // fresh database would serve an empty calendar for a full day.
  //
  // Second, and less obvious: clearing and re-adding the old repeatables reset
  // their timers, so on a day of frequent deploys the six-hour sync is pushed six
  // hours into the future every time and never actually fires.
  //
  // So the trigger is data staleness rather than a fresh timer, which is
  // self-correcting in both cases and idles harmlessly when the data is current.
  const [cat] = await sql`
    select count(*)::int as leagues,
           max(created_at) as newest
    from leagues
  `;
  // NOT events.updated_at, which was the obvious choice and is useless: the
  // live-scores tick writes that column every 60 seconds, so "when were the events
  // last touched" is always about a minute ago and the sweep is never stale. Between
  // that and the repeatable's timer restarting on every boot, the full fixture sweep
  // stopped running altogether on a day of frequent deploys -- the exact failure the
  // staleness check was added to prevent, reached from a different direction.
  //
  // rosters_synced_at is stamped only at the end of a full sync of that league, so
  // it means what this check needs it to mean.
  const [ev] = await sql`select max(rosters_synced_at) as synced from leagues where active`;

  const staleBy = (ts, ms) => !ts || Date.now() - new Date(ts).getTime() > ms;

  if (staleBy(cat.newest, 24 * 3600_000) || cat.leagues === 0) {
    log('[queue] catalogue stale, refreshing now');
    await queues.sync.add(
      'sync-catalogue',
      { kind: 'catalogue' },
      { jobId: `seed-cat-${dayStamp()}` },
    );
  }
  // Display names only arrive with a fixture sweep, so a catalogue that has never
  // been swept shows raw slugs however fresh its fixtures are.
  const unnamed = await q.leaguesMissingRealName();
  // Rosters arrived after the first sweeps, so an existing catalogue has fixtures
  // but only the clubs that happened to be playing. One backfill, then never again.
  const rosterless = await q.leaguesMissingRosters();

  const stale = staleBy(ev.synced, config.sync.staleHours * 3600_000);
  const forced = config.sync.onBoot;

  if (stale || forced || unnamed > 0 || rosterless > 0) {
    /**
     * The job id has to describe WHY we are syncing, not just when.
     *
     * An hour bucket alone deduplicates against any sync already run in that hour
     * -- including one that ran before the code which created the new backfill
     * need. That is exactly what happened with rosters: the boot logged "syncing
     * now, rosterless: 354", BullMQ matched the id of the completed fixtures-only
     * sync from earlier the same hour, and the backfill silently never ran.
     *
     * Including the outstanding counts means a genuinely new backfill gets a new
     * id, while several instances booting together still collapse onto one job --
     * which is all the bucket was ever for. The counts shrink to zero as the work
     * lands, so this settles rather than looping.
     */
    /**
     * Backfills bucket by MINUTE, not by their outstanding counts.
     *
     * Keying on the counts looked like it described the need, but successive
     * backfills reset the same leagues and so produced a byte-identical id --
     * `u0-r354` twice running. BullMQ matched the completed job and skipped the
     * second: the same silent no-op the hour bucket caused, reached from a
     * different direction. Twice now, so the lesson is that a job id must not be
     * derived from state the work itself resets.
     *
     * A minute bucket still collapses a boot storm across instances, which is all
     * the deduplication was ever for, and can never block a later backfill. The
     * routine sweep keeps its hour bucket: that one genuinely is periodic.
     */
    // A forced sweep buckets by minute like a backfill does: its whole purpose is to
    // run now, and an hour bucket would match a sweep already done this hour and
    // silently skip the one that was asked for.
    const reason =
      forced || rosterless > 0 || unnamed > 0
        ? `backfill-${minuteStamp()}`
        : `seed-all-${hourStamp()}`;

    log(
      `[queue] syncing now (stale: ${stale}, forced: ${forced}, unnamed: ${unnamed}, rosterless: ${rosterless})`,
    );
    await queues.sync.add('sync-all', { kind: 'all' }, { jobId: reason, delay: 20_000 });
  }

  // The near window always gets one pass on boot, for the same reason the sweep has
  // a staleness check: a repeatable first fires one interval from NOW, so without
  // this every deploy leaves tonight's fixtures unrefreshed for three hours. It is
  // unconditional because it is cheap -- one request for each league with a game in
  // the next two days, measured at 74 -- and because "was it recently enough" is
  // exactly the reasoning that let the sweep stop running twice already. Bucketed
  // by hour so a boot storm collapses onto one job.
  await queues.sync.add(
    'sync-near',
    { kind: 'near' },
    { jobId: `seed-near-${hourStamp()}`, delay: 30_000 },
  );

  log('[queue] schedules installed');
}

/* Job ids are bucketed by time so that several instances booting together -- or one
   instance restarting twice in a minute -- enqueue the same job rather than one each.
   Separated by '-' and never ':' -- see the note on job ids in workers.js. */
const dayStamp = () => new Date().toISOString().slice(0, 10);
const hourStamp = () => new Date().toISOString().slice(0, 13);
const minuteStamp = () => new Date().toISOString().slice(0, 16).replace(':', '-');

export async function closeQueues() {
  await Promise.all(Object.values(queues).map((q) => q.close()));
  await connection.quit();
}
