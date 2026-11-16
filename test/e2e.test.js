'use strict';
// End-to-end test against the mock M-Channel (test/mock-mchannel.js), covering
// the go-live checklist (spec section 10) for the sync-only service:
//   bookings: M-Channel -> Postgres (fetch + webhook) + ack
//   inventory / rates / restrictions: Postgres -> M-Channel (POST /ari)
// Needs a disposable database:  MCHANNEL_SYNC_ENV=/path/to/test.env npm test
// The test DROPS and recreates the schema in that database.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

if (!process.env.MCHANNEL_SYNC_ENV) {
  test('e2e (skipped: set MCHANNEL_SYNC_ENV to a test env file)', { skip: true }, () => {});
  return;
}

const db = require('../src/lib/db');
const { createMock } = require('./mock-mchannel');
const { createApp } = require('../src/server');
const { Scheduler } = require('../src/scheduler');
const props = require('../src/lib/properties');
const pairing = require('../src/lib/pairing');
const { syncSetup } = require('../src/jobs/setup');
const { pullBookings } = require('../src/jobs/bookings-pull');
const { processAcks } = require('../src/jobs/ack-worker');
const { pushProperty, buildBatch, requestFullPush, runPushCycle } = require('../src/jobs/ari-push');
const { todayIn, addDays } = require('../src/lib/dates');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = {};

async function mockCall(path, body) {
  const res = await fetch(`${ctx.mockUrl}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const count = async (sql, params) => Number((await one(sql, params)).n);
const property = () => props.getById(ctx.pid);
const lastBatch = () => one('SELECT * FROM ari_batches WHERE property_id = $1 ORDER BY id DESC LIMIT 1', [ctx.pid]);
const waiting = (t) => count(`SELECT count(*) n FROM ${t} WHERE property_id = $1 AND version > pushed_version`, [ctx.pid]);
const day = (n) => addDays(ctx.today, n);
async function drainAcks() {
  for (let i = 0; i < 20; i++) {
    await processAcks();
    const n = await count(`SELECT count(*) n FROM booking_revisions WHERE ack_status IN ('pending','sending')`);
    if (!n) return;
    await sleep(50);
  }
}

test.before(async () => {
  await db.query('DROP SCHEMA IF EXISTS mchannel CASCADE');
  await db.migrate();
  ctx.mock = createMock();
  ctx.mockUrl = await ctx.mock.listen(0);
  ctx.scheduler = new Scheduler(); // not started: the test drives the jobs
  const app = createApp(ctx.scheduler);
  await new Promise((r) => {
    ctx.server = app.listen(0, '127.0.0.1', r);
  });
  ctx.appUrl = `http://127.0.0.1:${ctx.server.address().port}`;
  ctx.today = todayIn('Asia/Kolkata');
});

test.after(async () => {
  await runPushCycle().catch(() => {});
  ctx.server.close();
  await ctx.mock.close();
  await db.close();
});

// ---------------------------------------------------------------- pairing
test('1. pairing stores the key and secret encrypted, plus the mapping', async () => {
  const r = await pairing.claim({
    code: 'MCH-TEST-0001', env: 'staging', base_url: ctx.mockUrl,
    hotel: { pms_hotel_id: 'H001', name: 'Hotel Example', timezone: 'Asia/Kolkata', currency: 'INR' },
    room_types: [
      { pms_ref: 'RT-1', name: 'Standard Room', rooms: 10, base_occupancy: 2, max_occupancy: 3 },
      { pms_ref: 'RT-2', name: 'Deluxe Room', rooms: 6, base_occupancy: 2, max_occupancy: 3 },
    ],
    rate_plans: [
      { pms_ref: 'RT-1|EP', pms_room_type_ref: 'RT-1', name: 'Room Only', meal_plan: 'room_only', sell_mode: 'per_room' },
      { pms_ref: 'RT-1|CP', pms_room_type_ref: 'RT-1', name: 'CP', meal_plan: 'breakfast', sell_mode: 'per_person' },
    ],
  });
  assert.equal(r.mappings.length, 3);
  assert.equal(r.push_token, undefined);
  ctx.pid = r.property.id;
  const row = await property();
  assert.ok(!row.api_key_enc.includes(ctx.mock.state.apiKey));
  assert.ok(!row.webhook_secret_enc.includes(ctx.mock.state.webhookSecret));
  const token = ctx.mock.state.webhookUrl.split('/').pop();
  await mockCall('/__test/set', { webhookUrlLocal: `${ctx.appUrl}/mchannel/webhook/${token}` });
});

test('2. setup sync: room types, rate plans, ari_source = pms, rate_source = mchannel', async () => {
  await syncSetup(await property());
  assert.equal(await count('SELECT count(*) n FROM room_types WHERE property_id = $1', [ctx.pid]), 2);
  assert.equal(await count('SELECT count(*) n FROM rate_plans WHERE property_id = $1', [ctx.pid]), 3);
  const p = await property();
  assert.deepEqual([p.ari_source, p.rate_source], ['pms', 'mchannel']);
  ctx.ids = await mockCall('/__test/ids');
});

// ----------------------------------------------------- inventory -> M-Channel
test('3. 365 days of free rooms written in Postgres go out as compressed ranges (checklist 3)', async () => {
  await db.query(`SELECT set_availability('H001', 'RT-1', $1, $2, 10)`, [ctx.today, day(364)]);
  await db.query(`SELECT set_availability('H001', 'RT-2', $1, $2, 6)`, [ctx.today, day(364)]);
  assert.equal(await waiting('room_inventory'), 730);
  const s = await pushProperty(ctx.pid);
  assert.equal(s.sent, 1);
  const b = await lastBatch();
  assert.equal(b.status, 'sent');
  assert.equal(b.http_status, 202);
  assert.equal(b.row_count, 730);
  assert.equal(b.body.availability.length, 2, 'one range per room type');
  const std = b.body.availability.find((a) => a.room_type_id === ctx.ids.roomTypes[0].id);
  assert.deepEqual(std, { room_type_id: ctx.ids.roomTypes[0].id, date_from: ctx.today, date_to: day(364), availability: 10 });
  assert.equal(b.body.restrictions.length, 0);
  assert.equal(ctx.mock.state.ariRequests.at(-1).contract_version, '1.3.0');
  assert.equal(await waiting('room_inventory'), 0);
  assert.equal(ctx.mock.state.availability.size, 730);
});

test('4. a single change goes out alone; writing the same value again sends nothing (checklist 4-5)', async () => {
  await db.query(`SELECT set_availability('H001', 'RT-1', $1, $1, 4)`, [day(5)]);
  await pushProperty(ctx.pid);
  const b = await lastBatch();
  assert.deepEqual(b.body.availability, [{ room_type_id: ctx.ids.roomTypes[0].id, date: day(5), availability: 4 }]);
  assert.equal(ctx.mock.state.availability.get(`${ctx.ids.roomTypes[0].id}|${day(5)}`).availability, 4);

  const before = ctx.mock.state.ariRequests.length;
  await db.query(`SELECT set_availability('H001', 'RT-1', $1, $1, 4)`, [day(5)]);
  await db.query(`UPDATE room_inventory SET availability = availability WHERE room_type_id = $1`, [ctx.ids.roomTypes[0].id]);
  await pushProperty(ctx.pid);
  assert.equal(ctx.mock.state.ariRequests.length, before);
  const hist = (await db.query(`SELECT old_values->>'availability' o, new_values->>'availability' n FROM ari_history
      WHERE ref_id = $1 AND stay_date = $2 ORDER BY id`, [ctx.ids.roomTypes[0].id, day(5)])).rows;
  assert.deepEqual(hist, [{ o: null, n: '10' }, { o: '10', n: '4' }]);
});

test('5. a row changed while its batch was in flight is sent again', async () => {
  await db.query(`SELECT set_availability('H001', 'RT-2', $1, $1, 3)`, [day(10)]);
  const b = await buildBatch(await property());
  assert.ok(b);
  await db.query(`SELECT set_availability('H001', 'RT-2', $1, $1, 2)`, [day(10)]); // changes before the send
  await pushProperty(ctx.pid); // sends the pending batch (value 3) then a new one (value 2)
  const batches = (await db.query('SELECT body FROM ari_batches WHERE property_id = $1 AND id >= $2 ORDER BY id', [ctx.pid, b.id])).rows;
  assert.deepEqual(batches.map((x) => x.body.availability[0].availability), [3, 2]);
  assert.equal(await waiting('room_inventory'), 0);
  assert.equal(ctx.mock.state.availability.get(`${ctx.ids.roomTypes[1].id}|${day(10)}`).availability, 2);
});

test('6. after a 429 the batch is retried with the same idempotency_key and applied once (checklist 6)', async () => {
  await mockCall('/__test/set', { fail429Once: true });
  const reqBefore = ctx.mock.state.ariRequests.length;
  const appliedBefore = ctx.mock.state.appliedBatches;
  await db.query(`SELECT set_availability('H001', 'RT-2', $1, $1, 5)`, [day(3)]);
  let s = await pushProperty(ctx.pid);
  assert.equal(s.retry, 1);
  let b = await lastBatch();
  assert.equal(b.status, 'pending');
  assert.equal(b.http_status, 429);
  assert.equal(await waiting('room_inventory'), 1, 'still waiting');
  s = await pushProperty(ctx.pid);
  assert.equal(s.waiting, true, 'waits for retry_after_seconds');
  await sleep(1100);
  s = await pushProperty(ctx.pid);
  assert.equal(s.sent, 1);
  b = await lastBatch();
  assert.equal(b.status, 'sent');
  const reqs = ctx.mock.state.ariRequests.slice(reqBefore);
  assert.equal(reqs.length, 2);
  assert.equal(reqs[0].idempotency_key, reqs[1].idempotency_key);
  assert.equal(ctx.mock.state.appliedBatches, appliedBefore + 1);
  assert.equal(await waiting('room_inventory'), 0);
});

test('7. past dates are not sent', async () => {
  await db.query(`INSERT INTO room_inventory (room_type_id, stay_date, availability) VALUES ($1, $2, 7)`,
    [ctx.ids.roomTypes[0].id, addDays(ctx.today, -1)]);
  const before = ctx.mock.state.ariRequests.length;
  await pushProperty(ctx.pid);
  assert.equal(ctx.mock.state.ariRequests.length, before);
  const r = await one('SELECT pms_room_type_ref, push_error, version = pushed_version AS done FROM room_inventory WHERE stay_date = $1', [addDays(ctx.today, -1)]);
  assert.deepEqual(r, { pms_room_type_ref: 'RT-1', push_error: 'past date, not sent', done: true });
});

// ------------------------------------------------- rates / restrictions -> M-Channel
test('8. rate_source = mchannel: prices stay in Postgres (alert), restrictions are sent (checklist 14)', async () => {
  await db.query(`SELECT set_rate('H001', 'RT-1|EP', $1, $2, 4500)`, [day(1), day(3)]);
  await db.query(`SELECT set_restrictions('H001', 'RT-1|EP', $1, $2, p_min_stay_arrival => 2)`, [day(20), day(22)]);
  await pushProperty(ctx.pid);
  const b = await lastBatch();
  assert.deepEqual(b.body.restrictions, [{ rate_plan_id: ctx.ids.ratePlans[0].id, date_from: day(20), date_to: day(22), min_stay_arrival: 2 }]);
  assert.equal(await waiting('room_rates'), 3, 'prices not sent');
  assert.equal(await waiting('rate_restrictions'), 0);
  assert.equal(await count(`SELECT count(*) n FROM alerts WHERE kind = 'not_sent_rate_source'`), 1);
  await pushProperty(ctx.pid);
  assert.equal(await count(`SELECT count(*) n FROM alerts WHERE kind = 'not_sent_rate_source'`), 1, 'alert only once');
});

test('9. a 409 from M-Channel is not retried; the rows keep the error', async () => {
  await db.query(`UPDATE properties SET rate_source = 'pms' WHERE id = $1`, [ctx.pid]); // local setting out of date
  await pushProperty(ctx.pid);
  const b = await lastBatch();
  assert.equal(b.status, 'failed');
  assert.equal(b.http_status, 409);
  assert.equal(b.attempts, 1);
  assert.equal(await waiting('room_rates'), 0);
  const r = await one('SELECT push_error FROM room_rates WHERE stay_date = $1', [day(1)]);
  assert.match(r.push_error, /409/);
  assert.equal(await count(`SELECT count(*) n FROM alerts WHERE kind = 'ari_push_failed'`), 1);
  assert.equal((await property()).setup_synced_at, null, 'settings are re-read');
  await syncSetup(await property());
  assert.equal((await property()).rate_source, 'mchannel');
});

test('10. rate_source = pms: per-room and per-guest prices with restrictions in one item', async () => {
  await mockCall('/__test/set', { property: { rate_source: 'pms' } });
  await syncSetup(await property());
  const ep = ctx.ids.ratePlans[0].id;
  const cp = ctx.ids.ratePlans[1].id;
  await db.query(`SELECT set_rate('H001', 'RT-1|EP', $1, $2, 2800)`, [day(30), day(31)]);
  await db.query(`SELECT set_rate('H001', 'RT-1|CP', $1, $1, 3000, 1)`, [day(30)]);
  await db.query(`SELECT set_rate('H001', 'RT-1|CP', $1, $1, 3500.5, 2)`, [day(30)]);
  await db.query(`SELECT set_restrictions('H001', 'RT-1|EP', $1, $1, p_stop_sell => true)`, [day(31)]);
  await pushProperty(ctx.pid);
  const b = await lastBatch();
  assert.equal(b.status, 'sent');
  const items = b.body.restrictions;
  assert.deepEqual(items.find((x) => x.rate_plan_id === cp), { rate_plan_id: cp, date: day(30), rates: [{ occupancy: 1, rate: '3000.00' }, { occupancy: 2, rate: '3500.50' }] });
  const epItems = items.filter((x) => x.rate_plan_id === ep);
  assert.deepEqual(epItems.find((x) => x.date === day(31)), { rate_plan_id: ep, date: day(31), rate: '2800.00', stop_sell: true });
  assert.equal(ctx.mock.state.rates.get(`${cp}|${day(30)}|2`).rate, '3500.50');
  assert.equal(await waiting('room_rates'), 0);
  // the earlier prices that got the 409 are sent once they change again
  await db.query(`SELECT set_rate('H001', 'RT-1|EP', $1, $2, 4600)`, [day(1), day(3)]);
  await pushProperty(ctx.pid);
  assert.deepEqual((await lastBatch()).body.restrictions, [{ rate_plan_id: ep, date_from: day(1), date_to: day(3), rate: '4600.00' }]);
});

test('11. full push re-sends every future row once a day', async () => {
  await requestFullPush(await property());
  await pushProperty(ctx.pid);
  const b = await lastBatch();
  assert.equal(b.sync_type, 'full');
  assert.equal(b.status, 'sent');
  assert.ok(b.row_count >= 730);
  assert.equal((await property()).full_push_requested, false);
  await assert.rejects(requestFullPush(await property()), /last 20 hours/);
});

test('12. functions refuse unknown codes; table checks refuse bad values', async () => {
  await assert.rejects(db.query(`SELECT set_availability('H001', 'RT-9', $1, $1, 3)`, [day(1)]), /not mapped/);
  await assert.rejects(db.query(`SELECT set_availability('H999', 'RT-1', $1, $1, 3)`, [day(1)]), /no paired hotel/);
  await assert.rejects(db.query(`SELECT set_availability('H001', 'RT-1', $1, $1, -1)`, [day(1)]), /check constraint/);
  await assert.rejects(db.query(`SELECT set_restrictions('H001', 'RT-1|EP', $1, $1)`, [day(1)]), /at least one/);
});

// ---------------------------------------------------- bookings -> Postgres
test('13. booking.created webhook: signature verified, saved, ack imported (checklist 7)', async () => {
  const r = await mockCall('/__test/booking', { action: 'create', webhook: true });
  assert.equal(r.webhook.response.status, 200, r.webhook.response.text);
  ctx.b1 = r.booking;
  ctx.b1event = r.webhook.event;
  const b = await one('SELECT * FROM bookings WHERE id = $1', [ctx.b1.id]);
  assert.equal(b.status, 'new');
  assert.equal(b.amount, '5600.00');
  assert.equal(await count('SELECT count(*) n FROM booking_room_nights WHERE booking_id = $1', [ctx.b1.id]), 2);
  await drainAcks();
  const ack = ctx.mock.state.acks.find((a) => a.revision_id === ctx.b1.revision_id);
  assert.equal(ack.result, 'imported');
  assert.equal(ack.pms_booking_id, String(b.pms_booking_id));
});

test('14. same event twice -> 200, ignored; Re-send -> acked again (checklist 8)', async () => {
  const acksBefore = ctx.mock.state.acks.length;
  const dup = await mockCall('/__test/webhook', { event: ctx.b1event });
  assert.equal(dup.status, 200);
  assert.match(dup.text, /duplicate/);
  await drainAcks();
  assert.equal(ctx.mock.state.acks.length, acksBefore);
  const resend = await mockCall('/__test/webhook', { event: { ...ctx.b1event, event_id: crypto.randomUUID() } });
  assert.equal(resend.status, 200);
  await drainAcks();
  assert.equal(ctx.mock.state.acks.length, acksBefore + 1);
});

test('15. modified then cancelled; an older revision arriving late is ignored (checklist 9)', async () => {
  const m = await mockCall('/__test/booking', { action: 'modify', id: ctx.b1.id, webhook: true, nights: 3 });
  const c = await mockCall('/__test/booking', { action: 'cancel', id: ctx.b1.id, webhook: true });
  assert.equal(m.webhook.response.status, 200);
  assert.equal(c.webhook.response.status, 200);
  await drainAcks();
  assert.equal(ctx.mock.state.acks.find((a) => a.revision_id === m.booking.revision_id).result, 'updated');
  assert.equal(ctx.mock.state.acks.find((a) => a.revision_id === c.booking.revision_id).result, 'cancelled');
  const b = await one('SELECT status, revision_seq, cancelled_at FROM bookings WHERE id = $1', [ctx.b1.id]);
  assert.equal(b.status, 'cancelled');
  assert.equal(b.revision_seq, 3);
  assert.ok(b.cancelled_at);

  // another booking: revision 2 arrives before revision 1
  const r1 = await mockCall('/__test/booking', { action: 'create' });
  const r2 = await mockCall('/__test/booking', { action: 'modify', id: r1.booking.id, nights: 4 });
  const ev = (bk, name) => ({
    contract_version: '1.3.0', event: name, event_id: crypto.randomUUID(), occurred_at: new Date().toISOString(),
    property_id: ctx.pid, data: { booking: bk },
  });
  assert.equal((await mockCall('/__test/webhook', { event: ev(r2.booking, 'booking.modified') })).status, 200);
  const late = await mockCall('/__test/webhook', { event: ev(r1.booking, 'booking.created') });
  assert.equal(late.status, 200);
  assert.match(late.text, /older revision/);
  assert.equal((await one('SELECT revision_seq FROM bookings WHERE id = $1', [r1.booking.id])).revision_seq, 2);
  await drainAcks();
});

test('16. unmapped booking saved as unallocated with an alert (checklist 11)', async () => {
  const r = await mockCall('/__test/booking', { action: 'create', webhook: true, unmapped: true });
  assert.equal(r.webhook.response.status, 200);
  assert.equal((await one('SELECT is_unmapped FROM bookings WHERE id = $1', [r.booking.id])).is_unmapped, true);
  assert.equal(await count(`SELECT count(*) n FROM alerts WHERE kind = 'booking_unmapped'`), 1);
  await drainAcks();
});

test('17. wrong signature -> 401, nothing saved; old timestamp -> 401 (checklist 12)', async () => {
  const r = await mockCall('/__test/booking', { action: 'create', webhook: true, badSignature: true });
  assert.equal(r.webhook.response.status, 401);
  assert.equal(await count('SELECT count(*) n FROM bookings WHERE id = $1', [r.booking.id]), 0);
  const old = await mockCall('/__test/webhook', {
    event: { ...r.webhook.event, event_id: crypto.randomUUID() }, options: { timestamp: Math.floor(Date.now() / 1000) - 600 },
  });
  assert.equal(old.status, 401);
  ctx.missed = r.booking;
});

test('18. the fetch picks up bookings that never came by webhook (checklist 13), multi-room', async () => {
  const multi = await mockCall('/__test/booking', { action: 'create', rooms: 2, nights: 2 });
  await pullBookings(await property());
  assert.equal(await count('SELECT count(*) n FROM bookings WHERE id = ANY($1::uuid[])', [[ctx.missed.id, multi.booking.id]]), 2);
  assert.equal(await count('SELECT count(*) n FROM booking_rooms WHERE booking_id = $1', [multi.booking.id]), 2);
  await drainAcks();
  const unacked = [...ctx.mock.state.bookings.values()].filter((b) => !ctx.mock.state.acked.has(`${b.id}|${b.revision_id}`));
  assert.deepEqual(unacked.map((b) => b.id), []);
});

test('19. the PMS can report a booking it could not take (checklist 10)', async () => {
  const r = await one(`SELECT ack_booking($1, 'failed', 'No availability: Standard Room on 2026-11-21') AS r`, [ctx.missed.id]);
  assert.match(r.r, /queued/);
  await drainAcks();
  const ack = ctx.mock.state.acks.filter((a) => a.booking_id === ctx.missed.id).pop();
  assert.equal(ack.result, 'failed');
  assert.match(ack.failure_reason, /No availability/);
  await assert.rejects(db.query(`SELECT ack_booking($1, 'failed')`, [ctx.missed.id]), /failure_reason/);
});

test('20. only the webhook and /health answer over HTTP', async () => {
  const h = await (await fetch(`${ctx.appUrl}/health`)).json();
  assert.equal(h.ok, true);
  assert.equal((await fetch(`${ctx.appUrl}/api/properties`)).status, 404);
  assert.equal((await fetch(`${ctx.appUrl}/mchannel/webhook/unknown`, { method: 'POST', body: '{}' })).status, 404);
});
