'use strict';
// Two hotels side by side (each paired with its own M-Channel key): bookings,
// inventory and rates must stay with their own hotel.
//   MCHANNEL_SYNC_ENV=/path/to/test.env node --test test/multi.test.js   (drops the schema)

const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.MCHANNEL_SYNC_ENV) {
  test('multi (skipped: set MCHANNEL_SYNC_ENV)', { skip: true }, () => {});
  return;
}

const db = require('../src/lib/db');
const { createMock } = require('./mock-mchannel');
const { createApp } = require('../src/server');
const props = require('../src/lib/properties');
const pairing = require('../src/lib/pairing');
const { Scheduler } = require('../src/scheduler');
const { processAcks } = require('../src/jobs/ack-worker');
const { runPushCycle } = require('../src/jobs/ari-push');
const { todayIn, addDays } = require('../src/lib/dates');

const H = {};
let server;
let appUrl;
const one = async (sql, p) => (await db.query(sql, p)).rows[0];

test.before(async () => {
  await db.query('DROP SCHEMA IF EXISTS mchannel CASCADE');
  await db.migrate();
  const app = createApp(new Scheduler());
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  appUrl = `http://127.0.0.1:${server.address().port}`;
  for (const [code, name] of [['H001', 'Hotel One'], ['H002', 'Hotel Two'], ['H003', 'Hotel Three']]) {
    const mock = createMock();
    mock.state.property.name = name;
    const url = await mock.listen(0);
    const r = await pairing.claim({
      code: 'MCH-TEST-0001', env: 'staging', base_url: url,
      hotel: { pms_hotel_id: code, name, timezone: 'Asia/Kolkata' },
      room_types: [{ pms_ref: 'RT-1', name: 'Standard Room', rooms: 10, base_occupancy: 2, max_occupancy: 3 }],
      rate_plans: [{ pms_ref: 'RT-1|EP', pms_room_type_ref: 'RT-1', name: 'Room Only', meal_plan: 'room_only', sell_mode: 'per_room' }],
    });
    const token = mock.state.webhookUrl.split('/').pop();
    await fetch(`${url}/__test/set`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ webhookUrlLocal: `${appUrl}/mchannel/webhook/${token}` }) });
    H[code] = { mock, url, pid: r.property.id };
  }
});

test.after(async () => {
  server.close();
  for (const h of Object.values(H)) await h.mock.close();
  await db.close();
});

test('three hotels: setup, bookings and pushes stay with their own hotel', async () => {
  const sched = new Scheduler();
  // setup + booking fetch for every hotel, the way the running service does it
  await sched.tick();
  for (const h of Object.values(H)) {
    const p = await props.getById(h.pid);
    assert.ok(p.setup_synced_at && p.bookings_pulled_at, 'setup and fetch ran');
  }
  assert.equal((await one('SELECT count(*)::int n FROM room_types')).n, 6);

  // the same PMS codes (RT-1) in every hotel, different numbers
  const today = todayIn('Asia/Kolkata');
  for (const [code, free] of [['H001', 4], ['H002', 7], ['H003', 2]]) {
    await db.query(`SELECT set_availability($1, 'RT-1', $2, $3, $4)`, [code, today, addDays(today, 29), free]);
  }
  await runPushCycle();
  for (const [code, free] of [['H001', 4], ['H002', 7], ['H003', 2]]) {
    const m = H[code].mock.state;
    assert.equal(m.ariRequests.length, 1, `${code}: one batch`);
    assert.deepEqual(m.ariRequests[0].availability.map((a) => a.availability), [free], `${code}: own value only`);
    assert.equal(m.ariRequests[0].availability[0].room_type_id, m.roomTypes[0].id, `${code}: own room type id`);
  }

  // bookings: one by webhook into H001, one fetched for H002, none for H003
  const post = (h, body) => fetch(`${h.url}/__test/booking`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const b1 = await post(H.H001, { action: 'create', webhook: true });
  assert.equal(b1.webhook.response.status, 200);
  const b2 = await post(H.H002, { action: 'create' });
  // a webhook signed with hotel 1's secret sent to hotel 2's URL is refused
  const t2 = H.H002.mock.state.webhookUrl.split('/').pop();
  H.H001.mock.state.webhookUrlLocal = `${appUrl}/mchannel/webhook/${t2}`;
  const cross = await post(H.H001, { action: 'create', webhook: true });
  assert.equal(cross.webhook.response.status, 401);

  await new Scheduler().runFor(await props.getById(H.H002.pid), ['bookings']);
  for (let i = 0; i < 5; i++) await processAcks();
  const rows = (await db.query(`SELECT b.id, p.pms_hotel_id FROM bookings b JOIN properties p ON p.id = b.property_id ORDER BY 2`)).rows;
  assert.deepEqual(rows.map((r) => [r.pms_hotel_id, r.id]), [['H001', b1.booking.id], ['H002', b2.booking.id]]);
  assert.deepEqual(H.H001.mock.state.acks.map((a) => a.booking_id), [b1.booking.id], 'ack went to hotel 1 only');
  assert.deepEqual(H.H002.mock.state.acks.map((a) => a.booking_id), [b2.booking.id], 'ack went to hotel 2 only');
  assert.equal(H.H003.mock.state.acks.length, 0);
});

test('a hotel connected with an existing API key (no pairing code) gets its bookings fetched', async () => {
  const mock = createMock();
  const url = await mock.listen(0);
  H.KEY = { mock, url };
  const pid = mock.state.property.id;
  const post = (body) => fetch(`${url}/__test/booking`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const b = await post({ action: 'create' });

  await assert.rejects(pairing.connectWithKey({ propertyId: pid, apiKey: 'wrong-key-123', env: 'production', base_url: url }), /wrong|unauthorized/i);
  await assert.rejects(pairing.connectWithKey({ propertyId: '00000000-0000-0000-0000-000000000000', apiKey: mock.state.apiKey, base_url: url }), /does not list/);
  const rec = await pairing.connectWithKey({ propertyId: pid, apiKey: mock.state.apiKey, env: 'production', base_url: url, pms_hotel_id: 'H004' });
  assert.equal(rec.pms_hotel_id, 'H004');
  const row = await props.getById(pid);
  assert.ok(!row.api_key_enc.includes(mock.state.apiKey), 'key stored encrypted');

  await new Scheduler().runFor(row, ['setup', 'bookings']);
  for (let i = 0; i < 3; i++) await processAcks();
  const saved = await one('SELECT status, ack_status FROM bookings WHERE id = $1', [b.booking.id]);
  assert.deepEqual(saved, { status: 'new', ack_status: 'acked' });
  assert.equal(mock.state.acks[0].result, 'imported');

  // no webhook secret: the webhook address answers 404 instead of accepting unsigned data
  const token = row.webhook_token;
  assert.equal((await fetch(`${appUrl}/mchannel/webhook/${token}`, { method: 'POST', body: '{}' })).status, 404);
  // and pushes work with the key too
  await db.query(`SELECT set_availability('H004', 'Standard Room', current_date + 1, current_date + 1, 3)`);
  await runPushCycle();
  assert.equal(mock.state.ariRequests.length, 1);
});
