'use strict';
// The sync loop, for every enabled hotel:
//   bookings  every BOOKING_PULL_MINUTES  fetch new / changed bookings (+ unacked sweep), store, ack
//   setup     every SETUP_SYNC_HOURS      room types, rate plans, ari_source / rate_source
// Workers:
//   ARI push  every PUSH_INTERVAL_SECONDS  send changed inventory / rates / restrictions
//   acks      every ACK_INTERVAL_SECONDS   send pending booking acks
// A failing job backs off (1, 2, 4 ... 30 min, never longer than its interval).

const config = require('./config');
const db = require('./lib/db');
const log = require('./lib/logger');
const props = require('./lib/properties');
const { syncSetup } = require('./jobs/setup');
const { pullBookings } = require('./jobs/bookings-pull');
const { processAcks, resetStuck } = require('./jobs/ack-worker');
const { runPushCycle } = require('./jobs/ari-push');

const MIN = 60000;
const INTERVALS = {
  setup: config.setupSyncHours * 60 * MIN,
  bookings: config.bookingPullMinutes * MIN,
};
const LAST_FIELD = { setup: 'setup_synced_at', bookings: 'bookings_pulled_at' };
const JOBS = { setup: syncSetup, bookings: pullBookings };

class Scheduler {
  constructor() {
    this.next = new Map(); // `${pid}:${job}` -> epoch ms
    this.failures = new Map();
    this.busy = new Set();
    this.timers = [];
    this.stopped = false;
  }

  dueAt(p, job) {
    const k = `${p.id}:${job}`;
    // setup_synced_at is cleared after a 409 so the settings are re-read soon
    if (job === 'setup' && !p.setup_synced_at) return 0;
    if (this.next.has(k)) return this.next.get(k);
    const last = p[LAST_FIELD[job]];
    return last ? new Date(last).getTime() + INTERVALS[job] : 0;
  }

  async alertOnAuth(p, err) {
    if (!err || ![401, 403].includes(err.status)) return;
    const open = await db.query(
      `SELECT 1 FROM alerts WHERE property_id = $1 AND kind = 'auth_failed' AND resolved_at IS NULL LIMIT 1`, [p.id]);
    if (open.rowCount) return;
    await db.query(
      `INSERT INTO alerts (property_id, kind, message) VALUES ($1, 'auth_failed', $2)`,
      [p.id, `M-Channel refused the API key (${err.status} ${err.code}). If the key was revoked, pair the hotel again.`],
    );
  }

  async runFor(p, jobs) {
    const results = {};
    this.busy.add(p.id);
    try {
      for (const job of jobs) {
        const k = `${p.id}:${job}`;
        const fresh = (await props.getById(p.id)) || p;
        try {
          results[job] = { ok: true, ...(await JOBS[job](fresh)) };
          this.failures.delete(k);
          this.next.set(k, Date.now() + INTERVALS[job]);
        } catch (err) {
          const n = (this.failures.get(k) || 0) + 1;
          this.failures.set(k, n);
          this.next.set(k, Date.now() + Math.min(INTERVALS[job], Math.min(30, 2 ** (n - 1)) * MIN));
          if (job === 'setup') {
            await db.query('UPDATE properties SET setup_synced_at = now() - make_interval(hours => $2) WHERE id = $1 AND setup_synced_at IS NULL',
              [p.id, config.setupSyncHours]).catch(() => {});
          }
          results[job] = { ok: false, error: typeof err.summary === 'function' ? err.summary() : err.message };
          await this.alertOnAuth(p, err).catch(() => {});
        }
      }
    } finally {
      this.busy.delete(p.id);
    }
    return results;
  }

  async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const work = [];
      for (const p of await props.listEnabled()) {
        if (this.busy.has(p.id)) continue;
        const jobs = Object.keys(JOBS).filter((j) => this.dueAt(p, j) <= now);
        if (jobs.length) work.push([p, jobs]);
      }
      for (let i = 0; i < work.length; i += 4) {
        await Promise.all(work.slice(i, i + 4).map(([p, jobs]) => this.runFor(p, jobs)));
      }
    } catch (err) {
      log.error('scheduler tick failed', { err });
    } finally {
      this.ticking = false;
    }
  }

  kickAcks() {
    setImmediate(() => processAcks().catch((err) => log.error('ack worker failed', { err })));
  }

  async cleanup() {
    const days = config.retentionDays;
    await db.query(`DELETE FROM sync_runs WHERE started_at < now() - make_interval(days => $1)`, [days]);
    await db.query(`DELETE FROM webhook_events WHERE received_at < now() - make_interval(days => $1)`, [days]);
    await db.query(`DELETE FROM alerts WHERE resolved_at < now() - make_interval(days => $1)`, [days]);
    await db.query(`DELETE FROM ari_batches WHERE status = 'sent' AND sent_at < now() - make_interval(days => $1)`, [days]);
    await db.query(`DELETE FROM ari_history WHERE recorded_at < now() - interval '400 days'`);
    log.info('cleanup done', { retention_days: days });
  }

  async start() {
    await resetStuck();
    const every = (ms, fn) => {
      const t = setInterval(() => {
        if (!this.stopped) fn().catch((err) => log.error('worker failed', { err }));
      }, ms);
      t.unref();
      this.timers.push(t);
    };
    every(20000, () => this.tick());
    every(config.ackIntervalSeconds * 1000, () => processAcks());
    every(config.pushIntervalSeconds * 1000, () => runPushCycle());
    every(24 * 60 * MIN, () => this.cleanup());
    setTimeout(() => this.tick(), 2000).unref();
    setTimeout(() => runPushCycle().catch((err) => log.error('push failed', { err })), 5000).unref();
    this.kickAcks();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
  }
}

module.exports = { Scheduler, INTERVALS, JOBS };
