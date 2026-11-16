'use strict';
// Pushes room inventory, rates and restrictions from Postgres to M-Channel
// (POST /properties/:id/ari, spec section 6).
//
// The PMS side writes room_inventory, room_rates and rate_restrictions. A
// trigger gives every real change a new version; rows with
// version > pushed_version are waiting. Each cycle, per hotel:
//   1. send the oldest pending batch (retries reuse its idempotency_key)
//   2. otherwise build one new batch from waiting rows:
//        - past dates are skipped (M-Channel rejects them)
//        - only the parts the hotel owns are sent (ari_source / rate_source)
//        - consecutive dates with the same value become one date range
//   3. on 202 the rows are marked sent, unless they changed in the meantime
// Batches go out one at a time per hotel, so an older value can never
// overwrite a newer one.

const crypto = require('crypto');
const config = require('../config');
const db = require('../lib/db');
const log = require('../lib/logger');
const { getById, listEnabled, clientFor } = require('../lib/properties');
const { RETRYABLE } = require('../lib/mchannel-client');
const { todayIn, addDays } = require('../lib/dates');

const MAX_ATTEMPTS = 30;
const RESTRICTION_FIELDS = ['min_stay_arrival', 'min_stay_through', 'max_stay', 'closed_to_arrival',
  'closed_to_departure', 'stop_sell'];

function newIdempotencyKey() {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `mcs-${day}-${crypto.randomBytes(8).toString('hex')}`;
}

function retryDelaySeconds(attempt, retryAfter) {
  if (retryAfter) return Math.min(Math.max(retryAfter, 1), 3600);
  return Math.min(15 * 2 ** Math.max(attempt - 1, 0), 1800);
}

async function alertOnce(propertyId, kind, message) {
  const open = await db.query(
    'SELECT 1 FROM alerts WHERE property_id = $1 AND kind = $2 AND resolved_at IS NULL LIMIT 1', [propertyId, kind]);
  if (!open.rowCount) {
    await db.query('INSERT INTO alerts (property_id, kind, message) VALUES ($1, $2, $3)', [propertyId, kind, message]);
  }
}

// Merge runs of consecutive dates that carry the same payload into ranges.
// entries: [{ key, date, payload, rows }] sorted by key, date
function toRanges(entries, idField) {
  const items = [];
  let cur = null;
  for (const e of entries) {
    const sig = JSON.stringify(e.payload);
    if (cur && cur.key === e.key && cur.sig === sig && addDays(cur.to, 1) === e.date) {
      cur.to = e.date;
      cur.rows.push(...e.rows);
      continue;
    }
    if (cur) items.push(cur);
    cur = { key: e.key, sig, from: e.date, to: e.date, payload: e.payload, rows: [...e.rows] };
  }
  if (cur) items.push(cur);
  return items.map((c) => ({
    item: {
      [idField]: c.key,
      ...(c.from === c.to ? { date: c.from } : { date_from: c.from, date_to: c.to }),
      ...c.payload,
    },
    rows: c.rows,
  }));
}

// Mark rows as handled up to the version the batch carried. A row that changed
// after the batch was built keeps waiting.
async function markRows(c, rows, error) {
  const set = error === undefined
    ? 'pushed_version = r.v, pushed_at = now(), push_error = NULL'
    : 'pushed_version = r.v, push_error = $2';
  const params = (list) => (error === undefined ? [JSON.stringify(list)] : [JSON.stringify(list), error]);
  if (rows.i && rows.i.length) {
    await c.query(
      `UPDATE room_inventory t SET ${set}
       FROM jsonb_to_recordset($1::jsonb) AS r(id uuid, d date, v bigint)
       WHERE t.room_type_id = r.id AND t.stay_date = r.d AND t.version = r.v`, params(rows.i));
  }
  if (rows.r && rows.r.length) {
    await c.query(
      `UPDATE room_rates t SET ${set}
       FROM jsonb_to_recordset($1::jsonb) AS r(id uuid, d date, o int, v bigint)
       WHERE t.rate_plan_id = r.id AND t.stay_date = r.d AND t.occupancy = r.o AND t.version = r.v`, params(rows.r));
  }
  if (rows.s && rows.s.length) {
    await c.query(
      `UPDATE rate_restrictions t SET ${set}
       FROM jsonb_to_recordset($1::jsonb) AS r(id uuid, d date, v bigint)
       WHERE t.rate_plan_id = r.id AND t.stay_date = r.d AND t.version = r.v`, params(rows.s));
  }
}

async function skipRows(propertyId, where, reason) {
  const counts = {};
  for (const t of ['room_inventory', 'room_rates', 'rate_restrictions']) {
    if (!where[t]) continue;
    const r = await db.query(
      `UPDATE ${t} SET pushed_version = version, push_error = $2
       WHERE property_id = $1 AND version > pushed_version AND ${where[t]}`, [propertyId, reason]);
    if (r.rowCount) counts[t] = r.rowCount;
  }
  return counts;
}

/** Build one batch from waiting rows. Returns the batch row, or null. */
async function buildBatch(property) {
  const pid = property.id;
  const today = todayIn(property.timezone);

  // Past dates: M-Channel rejects them, so they are not sent.
  const past = await skipRows(pid, {
    room_inventory: `stay_date < '${today}'`, room_rates: `stay_date < '${today}'`,
    rate_restrictions: `stay_date < '${today}'`,
  }, 'past date, not sent');
  if (Object.keys(past).length) log.info('past dates skipped', { property_id: pid, ...past });

  // Rows for room types / rate plans that M-Channel no longer has, and prices of derived plans.
  await skipRows(pid, {
    room_inventory: `room_type_id IN (SELECT id FROM room_types WHERE property_id = '${pid}' AND is_active = false)`,
    room_rates: `rate_plan_id IN (SELECT id FROM rate_plans WHERE property_id = '${pid}' AND is_active = false)`,
    rate_restrictions: `rate_plan_id IN (SELECT id FROM rate_plans WHERE property_id = '${pid}' AND is_active = false)`,
  }, 'room type / rate plan is no longer active in M-Channel');
  await skipRows(pid, {
    room_rates: `rate_plan_id IN (SELECT id FROM rate_plans WHERE property_id = '${pid}' AND rate_mode = 'derived')`,
  }, 'derived rate plan: its price follows the parent plan, not sent');

  // Ownership (spec 6.3). Unknown until the first setup sync.
  if (!property.ari_source || !property.rate_source) return null;
  const sendRooms = property.ari_source === 'pms';
  const sendRates = property.rate_source === 'pms';

  // A full push carries every waiting row in one batch; a delta is capped.
  const full = !!property.full_push_requested;
  const limit = full ? 2000000 : config.pushMaxRows;
  const inv = sendRooms ? (await db.query(
    `SELECT room_type_id AS id, stay_date AS d, availability, version AS v FROM room_inventory
     WHERE property_id = $1 AND version > pushed_version ORDER BY room_type_id, stay_date LIMIT $2`, [pid, limit])).rows : [];
  const rates = sendRates ? (await db.query(
    `SELECT rate_plan_id AS id, stay_date AS d, occupancy AS o, rate::text AS rate, version AS v FROM room_rates
     WHERE property_id = $1 AND version > pushed_version ORDER BY rate_plan_id, stay_date, occupancy LIMIT $2`, [pid, limit])).rows : [];
  const restr = sendRooms ? (await db.query(
    `SELECT rate_plan_id AS id, stay_date AS d, ${RESTRICTION_FIELDS.join(', ')}, version AS v FROM rate_restrictions
     WHERE property_id = $1 AND version > pushed_version ORDER BY rate_plan_id, stay_date LIMIT $2`, [pid, limit])).rows : [];

  // Tell the hotel once about rows that will not be sent.
  if (!sendRooms) {
    const w = await db.query(
      `SELECT (SELECT count(*) FROM room_inventory WHERE property_id = $1 AND version > pushed_version)
            + (SELECT count(*) FROM rate_restrictions WHERE property_id = $1 AND version > pushed_version) AS n`, [pid]);
    if (Number(w.rows[0].n)) {
      await alertOnce(pid, 'not_sent_ari_source',
        'ari_source = mchannel: free rooms and restrictions are edited in M-Channel, so rows in room_inventory / rate_restrictions are not sent.');
    }
  }
  if (!sendRates) {
    const w = await db.query('SELECT count(*) AS n FROM room_rates WHERE property_id = $1 AND version > pushed_version', [pid]);
    if (Number(w.rows[0].n)) {
      await alertOnce(pid, 'not_sent_rate_source',
        'rate_source = mchannel: prices are edited in M-Channel, so rows in room_rates are not sent.');
    }
  }
  if (!inv.length && !rates.length && !restr.length) return null;

  // availability[]
  const availItems = toRanges(inv.map((r) => ({
    key: r.id, date: r.d, payload: { availability: r.availability }, rows: [{ t: 'i', id: r.id, d: r.d, v: r.v }],
  })), 'room_type_id');

  // restrictions[]: one entry per rate plan and date with its prices and restrictions
  const byPlanDate = new Map();
  const entry = (id, d) => {
    const k = `${id}|${d}`;
    if (!byPlanDate.has(k)) byPlanDate.set(k, { key: id, date: d, payload: {}, rows: [] });
    return byPlanDate.get(k);
  };
  for (const r of rates) {
    const e = entry(r.id, r.d);
    if (r.o === 0) e.payload.rate = r.rate;
    else (e.payload.rates = e.payload.rates || []).push({ occupancy: r.o, rate: r.rate });
    e.rows.push({ t: 'r', id: r.id, d: r.d, o: r.o, v: r.v });
  }
  for (const r of restr) {
    const e = entry(r.id, r.d);
    for (const f of RESTRICTION_FIELDS) if (r[f] !== null && r[f] !== undefined) e.payload[f] = r[f];
    e.rows.push({ t: 's', id: r.id, d: r.d, v: r.v });
  }
  const planEntries = [...byPlanDate.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.date < b.date ? -1 : 1));
  for (const e of planEntries) {
    if (e.payload.rates) e.payload.rates.sort((a, b) => a.occupancy - b.occupancy);
  }
  const restrItems = toRanges(planEntries, 'rate_plan_id');

  // Cap the number of items; what does not fit waits for the next batch.
  const max = full ? Infinity : config.pushBatchMaxItems;
  const takeAvail = availItems.slice(0, max);
  const takeRestr = restrItems.slice(0, Math.max(0, max - takeAvail.length));
  const rowsSnap = { i: [], r: [], s: [] };
  for (const it of [...takeAvail, ...takeRestr]) {
    for (const row of it.rows) {
      const { t, ...rest } = row;
      rowsSnap[t].push(rest);
    }
  }

  const syncType = full ? 'full' : 'delta';
  const key = newIdempotencyKey();
  const body = {
    idempotency_key: key,
    sync_type: syncType,
    availability: takeAvail.map((x) => x.item),
    restrictions: takeRestr.map((x) => x.item),
  };
  const rowCount = rowsSnap.i.length + rowsSnap.r.length + rowsSnap.s.length;
  const batch = await db.tx(async (c) => {
    const ins = await c.query(
      `INSERT INTO ari_batches (property_id, idempotency_key, sync_type, body, rows, item_count, row_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [pid, key, syncType, body, rowsSnap, body.availability.length + body.restrictions.length, rowCount],
    );
    if (syncType === 'full') await c.query('UPDATE properties SET full_push_requested = false WHERE id = $1', [pid]);
    return ins.rows[0];
  });
  log.info('ari batch built', {
    property_id: pid, batch: batch.id, sync_type: syncType, items: batch.item_count, rows: rowCount,
  });
  return batch;
}

async function sendBatch(property, batch) {
  const attempt = batch.attempts + 1;
  try {
    const res = await clientFor(property).pushAri(property.id, batch.body, { attempts: 1 });
    const d = res.data || {};
    await db.tx(async (c) => {
      await c.query(
        `UPDATE ari_batches SET status = 'sent', attempts = $2, http_status = $3, mc_batch_id = $4,
                response = $5, error = NULL, sent_at = now() WHERE id = $1`,
        [batch.id, attempt, res.status, d.batch_id || null, res.body],
      );
      await markRows(c, batch.rows);
      await c.query('UPDATE properties SET ari_pushed_at = now() WHERE id = $1', [property.id]);
    });
    log.info('ari batch accepted', {
      property_id: property.id, batch: batch.id, mc_batch_id: d.batch_id, accepted_items: d.accepted_items,
    });
    return 'sent';
  } catch (err) {
    const summary = typeof err.summary === 'function' ? err.summary() : err.message;
    const retryable = err.status === undefined || RETRYABLE.has(err.status);
    if (retryable && attempt < MAX_ATTEMPTS) {
      const wait = retryDelaySeconds(attempt, err.retryAfter);
      await db.query(
        `UPDATE ari_batches SET attempts = $2, http_status = $3, error = $4,
                next_attempt_at = now() + make_interval(secs => $5) WHERE id = $1`,
        [batch.id, attempt, err.status ?? null, summary, wait],
      );
      log.warn('ari batch will be retried with the same idempotency_key', { batch: batch.id, wait_s: wait, err: summary });
      return 'retry';
    }
    // 400/401/403/404/409/422: never retried unchanged (spec 3.5). The rows keep
    // the error and are sent again only when their value changes.
    await db.tx(async (c) => {
      await c.query(
        `UPDATE ari_batches SET status = 'failed', attempts = $2, http_status = $3, error = $4, response = $5 WHERE id = $1`,
        [batch.id, attempt, err.status ?? null, summary, err.body || null],
      );
      await markRows(c, batch.rows, summary.slice(0, 500));
      await c.query(
        'INSERT INTO alerts (property_id, kind, message, data) VALUES ($1, $2, $3, $4)',
        [property.id, 'ari_push_failed',
          err.status === 409
            ? `M-Channel refused the push (409 conflict): that part is managed in M-Channel. ${summary}`
            : `ARI push refused: ${summary}`,
          { batch_id: batch.id, idempotency_key: batch.idempotency_key }],
      );
    });
    log.error('ari batch failed', { batch: batch.id, err: summary });
    if (err.status === 409) {
      // Ownership probably changed in M-Channel: refresh it before the next batch.
      await db.query('UPDATE properties SET setup_synced_at = NULL WHERE id = $1', [property.id]);
    }
    return 'failed';
  }
}

/** Push everything waiting for one hotel, in order. */
async function pushProperty(propertyId, { maxBatches = 20 } = {}) {
  const summary = { sent: 0, retry: 0, failed: 0, waiting: false };
  for (let i = 0; i < maxBatches; i++) {
    const property = await getById(propertyId);
    if (!property || !property.is_enabled) break;
    let batch = (await db.query(
      `SELECT * FROM ari_batches WHERE property_id = $1 AND status = 'pending' ORDER BY id LIMIT 1`, [propertyId],
    )).rows[0];
    if (batch && new Date(batch.next_attempt_at) > new Date()) {
      summary.waiting = true;
      break;
    }
    if (!batch) batch = await buildBatch(property);
    if (!batch) break;
    const r = await sendBatch(property, batch);
    summary[r]++;
    if (r === 'retry') break;
  }
  return summary;
}

let cyclePromise = null;
let cycleAgain = false;

function runPushCycle() {
  if (cyclePromise) {
    cycleAgain = true;
    return cyclePromise;
  }
  cyclePromise = (async () => {
    try {
      do {
        cycleAgain = false;
        for (const p of await listEnabled()) {
          try {
            await pushProperty(p.id);
          } catch (err) {
            log.error('push failed', { property_id: p.id, err });
          }
        }
      } while (cycleAgain);
    } finally {
      cyclePromise = null;
    }
  })();
  return cyclePromise;
}

/** Re-send every future row of a hotel, as sync_type = full (onboarding / recovery). */
async function requestFullPush(property, { force = false } = {}) {
  if (!force) {
    const recent = await db.query(
      `SELECT 1 FROM ari_batches WHERE property_id = $1 AND sync_type = 'full' AND status IN ('pending', 'sent')
         AND created_at > now() - interval '20 hours' LIMIT 1`, [property.id]);
    if (recent.rowCount) {
      throw new Error('A full push was already made in the last 20 hours (the spec allows one a day). Use --force for recovery.');
    }
  }
  const today = todayIn(property.timezone);
  const counts = {};
  await db.tx(async (c) => {
    for (const t of ['room_inventory', 'room_rates', 'rate_restrictions']) {
      const r = await c.query(`UPDATE ${t} SET pushed_version = 0 WHERE property_id = $1 AND stay_date >= $2`, [property.id, today]);
      counts[t] = r.rowCount;
    }
    await c.query('UPDATE properties SET full_push_requested = true WHERE id = $1', [property.id]);
  });
  return counts;
}

module.exports = { runPushCycle, pushProperty, buildBatch, requestFullPush, toRanges };
