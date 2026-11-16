'use strict';
// A small in-memory stand-in for M-Channel (contract 1.3.0), used by the
// end-to-end test and handy for local development:
//   node test/mock-mchannel.js 4010
// Control endpoints under /__test let a test create bookings, send signed
// webhooks and inspect what the service sent.

const http = require('http');
const crypto = require('crypto');

const CV = '1.3.0';
const uuid = () => crypto.randomUUID();
const nowZ = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function createMock() {
  const state = {
    baseUrl: '',
    code: 'MCH-TEST-0001',
    apiKey: 'mck_test_' + crypto.randomBytes(12).toString('hex'),
    webhookSecret: 'whsec_' + crypto.randomBytes(16).toString('hex'),
    webhookUrl: null,
    property: {
      id: uuid(), code: 'HEX', name: 'Hotel Example', currency: 'INR', timezone: 'Asia/Kolkata',
      status: 'live', ari_source: 'pms', rate_source: 'mchannel', channex_property_id: null,
      active_channels: [{ ota_code: 'BDC', title: 'Booking.com - Hotel Example', is_active: true, connection_id: uuid() }],
    },
    roomTypes: [],
    ratePlans: [],
    mappings: [],
    availability: new Map(), // `${rt}|${date}` -> {availability, updated_at}
    rates: new Map(),        // `${rp}|${date}|${occ}` -> {...}
    idempotency: new Map(),  // key -> {status, body}
    ariRequests: [],         // every POST /ari body received
    appliedBatches: 0,
    acks: [],
    bookings: new Map(),     // id -> booking (latest revision)
    acked: new Set(),        // `${booking_id}|${revision_id}`
    fail429Once: false,
    requests: [],
  };

  const std = { id: uuid(), code: 'STANDARD-ROOM', title: 'Standard Room', count_of_rooms: 10, occ_adults: 3, occ_children: 1, occ_infants: 1, default_occupancy: 2, is_active: true };
  const dlx = { id: uuid(), code: 'DELUXE-ROOM', title: 'Deluxe Room', count_of_rooms: 6, occ_adults: 3, occ_children: 1, occ_infants: 1, default_occupancy: 2, is_active: true };
  state.roomTypes.push(std, dlx);
  const ep = { id: uuid(), code: 'EP-1', title: 'Room Only', room_type_id: std.id, sell_mode: 'per_room', rate_mode: 'manual', meal_type: 'room_only', currency: 'INR', parent_rate_plan_id: null, occupancies: [{ occupancy: 2, is_primary: true }], is_active: true };
  const cp = { id: uuid(), code: 'CP-1', title: 'CP', room_type_id: std.id, sell_mode: 'per_person', rate_mode: 'manual', meal_type: 'breakfast', currency: 'INR', parent_rate_plan_id: null, occupancies: [{ occupancy: 1, is_primary: false }, { occupancy: 2, is_primary: true }], is_active: true };
  const dep = { id: uuid(), code: 'EP-2', title: 'Room Only', room_type_id: dlx.id, sell_mode: 'per_room', rate_mode: 'manual', meal_type: 'room_only', currency: 'INR', parent_rate_plan_id: null, occupancies: [{ occupancy: 2, is_primary: true }], is_active: true };
  state.ratePlans.push(ep, cp, dep);

  // Seed 30 days of prices held in M-Channel (rate_source = mchannel).
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  for (let i = 0; i < 30; i++) {
    const date = addDays(today, i);
    const t = '2026-11-14T05:07:18Z';
    state.rates.set(`${ep.id}|${date}|0`, { rate_plan_id: ep.id, date, occupancy: 0, rate: '2800.00', min_stay_arrival: null, min_stay_through: null, max_stay: null, closed_to_arrival: null, closed_to_departure: null, stop_sell: null, updated_at: t });
    state.rates.set(`${cp.id}|${date}|1`, { rate_plan_id: cp.id, date, occupancy: 1, rate: '3000.00', min_stay_arrival: null, min_stay_through: null, max_stay: null, closed_to_arrival: null, closed_to_departure: null, stop_sell: null, updated_at: t });
    state.rates.set(`${cp.id}|${date}|2`, { rate_plan_id: cp.id, date, occupancy: 2, rate: '3500.00', min_stay_arrival: 2, min_stay_through: null, max_stay: null, closed_to_arrival: false, closed_to_departure: null, stop_sell: null, updated_at: t });
    state.rates.set(`${dep.id}|${date}|0`, { rate_plan_id: dep.id, date, occupancy: 0, rate: '4200.00', min_stay_arrival: null, min_stay_through: null, max_stay: null, closed_to_arrival: null, closed_to_departure: null, stop_sell: null, updated_at: t });
  }

  const err = (res, status, code, message, extra = {}) => send(res, status, {
    contract_version: CV, error: { code, message, details: extra.details, request_id: uuid(), retry_after_seconds: extra.retry_after_seconds },
  });
  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function refFor(id, kind) {
    const m = state.mappings.find((x) => (kind === 'rt' ? x.room_type_id === id : x.rate_plan_id === id));
    return m ? (kind === 'rt' ? m.pms_room_type_ref : m.pms_rate_plan_ref) : null;
  }

  function expandDates(item) {
    if (item.date) return [item.date];
    const out = [];
    const wd = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
    for (let d = item.date_from; d <= item.date_to; d = addDays(d, 1)) {
      if (item.days && !item.days.includes(wd[new Date(d + 'T00:00:00Z').getUTCDay()])) continue;
      out.push(d);
    }
    return out;
  }

  function bookingList() {
    return [...state.bookings.values()];
  }

  async function sendWebhook(eventBody, { badSignature = false, timestamp } = {}) {
    const raw = JSON.stringify(eventBody);
    const ts = String(timestamp || Math.floor(Date.now() / 1000));
    let sig = crypto.createHmac('sha256', state.webhookSecret).update(ts + '.' + raw).digest('hex');
    if (badSignature) sig = sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a');
    const res = await fetch(state.webhookUrlLocal || state.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'X-MChannel-Event-Id': eventBody.event_id,
        'X-MChannel-Timestamp': ts, 'X-MChannel-Signature': sig,
      },
      body: raw,
    });
    return { status: res.status, text: await res.text() };
  }

  function makeBooking({ status = 'new', id, seq = 1, unmapped = false, arrival, nights = 2, rooms = 1 } = {}) {
    const rt = state.roomTypes[0];
    const rp = state.ratePlans[0];
    const a = arrival || addDays(today, 5);
    const roomList = [];
    for (let r = 0; r < rooms; r++) {
      const np = [];
      for (let n = 0; n < nights; n++) np.push({ date: addDays(a, n), amount: '2800.00' });
      roomList.push({
        room_type_id: unmapped ? null : rt.id, rate_plan_id: unmapped ? null : rp.id,
        pms_room_type_ref: unmapped ? null : refFor(rt.id, 'rt'), pms_rate_plan_ref: unmapped ? null : refFor(rp.id, 'rp'),
        ota_room_code: '1722499001', ota_rate_code: '68994901', ota_room_unique_id: null,
        checkin_date: a, checkout_date: addDays(a, nights), occupancy: { adults: 2, children: 0, infants: 0 },
        guests: [{ first_name: 'Asha', last_name: 'Raman' }], nightly_prices: np, amount: (2800 * nights).toFixed(2),
        taxes: [{ name: 'Goods & services tax', type: 'tax', amount: '280.00', is_inclusive: false, collected_by_ota: false }],
        services: [], meal_plan: null, is_cancelled: status === 'cancelled',
      });
    }
    const code = String(5346420000 + Math.floor(Math.random() * 999));
    return {
      id: id || uuid(), revision_id: uuid(), revision_seq: seq, property_id: state.property.id, status,
      ota_code: 'BDC', ota_name: 'Booking.com', secondary_ota_name: null, ota_reservation_code: code,
      unique_id: 'BDC-' + code, arrival_date: a, departure_date: addDays(a, nights), arrival_time: '14:00',
      booked_at: nowZ(), received_at: nowZ(), currency: 'INR', amount: (2800 * nights * rooms).toFixed(2),
      ota_commission: '840.00',
      guest: { first_name: 'Asha', last_name: 'Raman', email: 'a.raman@guest.booking.com', phone: null, address: null, city: null, country: 'IN', zip: null, language: 'en', company: null },
      occupancy: { adults: 2, children: 0, infants: 0 }, rooms: roomList, services: [],
      payment: { collect: 'property', type: 'credit_card', has_card: true, card_is_virtual: false, card_type: 'VI' },
      notes: 'Non-smoking room', cancellation_policy_text: null, is_unmapped: unmapped,
      channex: { booking_id: uuid(), revision_id: uuid() },
      _updated_at: Date.now(),
    };
  }

  const pub = (b) => { const { _updated_at, ...rest } = b; return rest; };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    if (raw) {
      try { body = JSON.parse(raw); } catch (_) { return err(res, 400, 'bad_json', 'bad json'); }
    }
    const p = url.pathname;
    state.requests.push({ method: req.method, path: p, query: Object.fromEntries(url.searchParams), body });

    // ---- test control ----
    if (p === '/__test/state') return send(res, 200, { acks: state.acks, ariRequests: state.ariRequests.length, appliedBatches: state.appliedBatches });
    if (p === '/__test/booking' && req.method === 'POST') {
      // {action: create|modify|cancel, id?, webhook: bool, badSignature, unmapped}
      const prev = body.id ? state.bookings.get(body.id) : null;
      const b = makeBooking({
        id: body.id, seq: prev ? prev.revision_seq + 1 : 1, unmapped: !!body.unmapped,
        status: body.action === 'cancel' ? 'cancelled' : prev ? 'modified' : 'new', nights: body.nights || 2,
        rooms: body.rooms || 1,
      });
      state.bookings.set(b.id, b);
      let webhook = null;
      if (body.webhook) {
        const ev = {
          contract_version: CV, event: b.status === 'new' ? 'booking.created' : b.status === 'cancelled' ? 'booking.cancelled' : 'booking.modified',
          event_id: uuid(), occurred_at: nowZ(), tenant_id: uuid(), property_id: state.property.id, data: { booking: pub(b) },
        };
        webhook = { event: ev, response: await sendWebhook(ev, { badSignature: !!body.badSignature }) };
      }
      return send(res, 200, { booking: pub(b), webhook });
    }
    if (p === '/__test/webhook' && req.method === 'POST') {
      return send(res, 200, await sendWebhook(body.event, body.options || {}));
    }
    if (p === '/__test/set' && req.method === 'POST') {
      Object.assign(state.property, body.property || {});
      if (body.fail429Once !== undefined) state.fail429Once = body.fail429Once;
      if (body.webhookUrlLocal) state.webhookUrlLocal = body.webhookUrlLocal;
      if (body.rate) { // edit a price inside "M-Channel"
        const k = `${body.rate.rate_plan_id}|${body.rate.date}|${body.rate.occupancy || 0}`;
        const cur = state.rates.get(k) || { rate_plan_id: body.rate.rate_plan_id, date: body.rate.date, occupancy: body.rate.occupancy || 0 };
        state.rates.set(k, { ...cur, rate: body.rate.rate, updated_at: nowZ() });
      }
      return send(res, 200, { ok: true });
    }
    if (p === '/__test/ids') return send(res, 200, { property: state.property, roomTypes: state.roomTypes, ratePlans: state.ratePlans, secret: state.webhookSecret });

    // ---- pairing (no key) ----
    if (p === '/api/v1/pairing/claim' && req.method === 'POST') {
      if (!body || body.code !== state.code) return err(res, 404, 'code_invalid', 'Unknown, used or revoked code');
      state.code = 'USED';
      state.webhookUrl = body.webhook_url;
      const mappings = [];
      const unmatched = { pms_room_types: [], pms_rate_plans: [], room_types: [], rate_plans: [] };
      for (const rt of body.room_types || []) {
        const m = state.roomTypes.find((x) => x.title.toLowerCase() === String(rt.name).toLowerCase() || x.code === rt.code);
        if (!m) { unmatched.pms_room_types.push(rt.pms_ref); continue; }
        const plans = (body.rate_plans || []).filter((r) => r.pms_room_type_ref === rt.pms_ref);
        if (!plans.length) mappings.push({ pms_room_type_ref: rt.pms_ref, pms_rate_plan_ref: null, room_type_id: m.id, rate_plan_id: null });
        for (const rp of plans) {
          const mp = state.ratePlans.find((x) => x.room_type_id === m.id && x.title.toLowerCase() === String(rp.name).toLowerCase());
          if (!mp) unmatched.pms_rate_plans.push(rp.pms_ref);
          mappings.push({ pms_room_type_ref: rt.pms_ref, pms_rate_plan_ref: mp ? rp.pms_ref : null, room_type_id: m.id, rate_plan_id: mp ? mp.id : null });
        }
      }
      state.mappings = mappings;
      return send(res, 201, {
        contract_version: CV,
        data: {
          api_key: state.apiKey, webhook_secret: state.webhookSecret, base_url: state.baseUrl,
          property: { id: state.property.id, name: state.property.name, code: state.property.code, status: state.property.status, ari_source: state.property.ari_source, rate_source: state.property.rate_source },
          mode: 'existing', mappings, unmatched, filled_fields: ['city'], next_steps: ['Push availability for the next 365 days'],
        },
      });
    }

    // ---- auth ----
    if (req.headers['x-mchannel-key'] !== state.apiKey) return err(res, 401, 'unauthorized', 'Missing, wrong, revoked or expired key');
    if (body && body.contract_version && body.contract_version.split('.')[0] !== '1') return err(res, 400, 'version_unsupported', 'Unknown contract MAJOR');

    const pid = state.property.id;
    if (p === '/api/v1/properties') return send(res, 200, { contract_version: CV, data: [state.property] });
    if (p === '/api/v1/pairing/status') {
      return send(res, 200, { contract_version: CV, data: [{ property_id: pid, name: state.property.name, status: state.property.status, checks: { paired: true, mapping_saved: state.mappings.length > 0, unmapped_room_types: 0, availability_received: state.availability.size > 0, rates_received: false, webhook_registered: !!state.webhookUrl, property_live: true, last_booking_acked_at: state.acks.length ? nowZ() : null } }] });
    }
    const m = p.match(/^\/api\/v1\/properties\/([^/]+)\/(.+)$/);
    if (m) {
      if (m[1] !== pid) return err(res, 404, 'not_found', 'Unknown hotel');
      const sub = m[2];
      if (sub === 'room-types') return send(res, 200, { contract_version: CV, data: state.roomTypes });
      if (sub === 'rate-plans') return send(res, 200, { contract_version: CV, data: state.ratePlans });
      if (sub === 'mappings' && req.method === 'PUT') {
        state.mappings = body.mappings;
        return send(res, 200, { contract_version: CV, data: { saved: body.mappings.length, unmapped_room_types: [], unmapped_rate_plans: [] } });
      }
      if (sub === 'ari' && req.method === 'POST') {
        state.ariRequests.push(body);
        if (!body.idempotency_key || body.idempotency_key.length < 8) return err(res, 422, 'validation_error', 'Validation failed', { details: { idempotency_key: ['Required'] } });
        if (state.idempotency.has(body.idempotency_key)) {
          const prev = state.idempotency.get(body.idempotency_key);
          return send(res, prev.status, prev.body);
        }
        if (state.fail429Once) {
          state.fail429Once = false;
          return err(res, 429, 'rate_limited', 'Too many requests', { retry_after_seconds: 1 });
        }
        const hasPrice = (body.restrictions || []).some((r) => r.rate !== undefined || r.rates !== undefined);
        if (hasPrice && state.property.rate_source === 'mchannel') return err(res, 409, 'conflict', 'Prices are managed in M-Channel');
        if ((body.availability || []).length && state.property.ari_source === 'mchannel') return err(res, 409, 'conflict', 'Availability is managed in M-Channel');
        const t = nowZ();
        let n = 0;
        for (const a of body.availability || []) {
          for (const d of expandDates(a)) {
            if (d < today) return err(res, 422, 'validation_error', 'Validation failed', { details: { date: ['Past date'] } });
            state.availability.set(`${a.room_type_id}|${d}`, { availability: a.availability, updated_at: t });
          }
          n++;
        }
        for (const r of body.restrictions || []) {
          for (const d of expandDates(r)) {
            const occs = r.rates ? r.rates.map((x) => [x.occupancy, x.rate]) : [[0, r.rate]];
            for (const [occ, rate] of occs) {
              const k = `${r.rate_plan_id}|${d}|${occ}`;
              const cur = state.rates.get(k) || { rate_plan_id: r.rate_plan_id, date: d, occupancy: occ };
              const next = { ...cur, updated_at: t };
              if (rate !== undefined) next.rate = rate;
              for (const f of ['min_stay_arrival', 'min_stay_through', 'max_stay', 'closed_to_arrival', 'closed_to_departure', 'stop_sell']) if (r[f] !== undefined) next[f] = r[f];
              state.rates.set(k, next);
            }
          }
          n++;
        }
        state.appliedBatches++;
        const resp = { contract_version: CV, data: { batch_id: uuid(), accepted_items: n, queued_at: t } };
        state.idempotency.set(body.idempotency_key, { status: 202, body: resp });
        return send(res, 202, resp);
      }
      if (sub === 'ari' && req.method === 'GET') {
        const q = Object.fromEntries(url.searchParams);
        const since = q.changed_since ? Date.parse(q.changed_since) : null;
        const inRange = (d) => (!q.date_from || d >= q.date_from) && (!q.date_to || d <= q.date_to);
        const fresh = (u) => since === null || Date.parse(u) > since;
        const availability = [];
        for (const [k, v] of state.availability) {
          const [rt, date] = k.split('|');
          if (inRange(date) && fresh(v.updated_at)) availability.push({ room_type_id: rt, pms_room_type_ref: refFor(rt, 'rt'), date, availability: v.availability, updated_at: v.updated_at });
        }
        const rates = [];
        for (const v of state.rates.values()) {
          if (inRange(v.date) && fresh(v.updated_at)) rates.push({ pms_rate_plan_ref: refFor(v.rate_plan_id, 'rp'), min_stay_arrival: null, min_stay_through: null, max_stay: null, closed_to_arrival: null, closed_to_departure: null, stop_sell: null, ...v });
        }
        return send(res, 200, { contract_version: CV, data: { property_id: pid, ari_source: state.property.ari_source, rate_source: state.property.rate_source, currency: 'INR', availability, rates } });
      }
      if (sub === 'bookings' && req.method === 'GET') {
        const q = Object.fromEntries(url.searchParams);
        if (!q.since) return err(res, 422, 'validation_error', 'since is required');
        const since = Date.parse(q.since);
        let list = bookingList().filter((b) => b._updated_at > since);
        if (q.only_unacked === 'true') list = list.filter((b) => !state.acked.has(`${b.id}|${b.revision_id}`));
        if (q.status) list = list.filter((b) => b.status === q.status);
        const limit = Math.min(Number(q.limit) || 50, 100);
        const start = Number(q.cursor || 0);
        const page = list.slice(start, start + limit).map(pub);
        const next = start + limit < list.length ? String(start + limit) : null;
        return send(res, 200, { contract_version: CV, data: page, next_cursor: next });
      }
      if (sub === 'health') return send(res, 200, { contract_version: CV, data: { property_id: pid, status: 'live', outbox_pending: 0, last_push_at: nowZ(), last_push_ok: true, unacked_bookings: bookingList().filter((b) => !state.acked.has(`${b.id}|${b.revision_id}`)).length, channels: [] } });
      if (sub === 'sync-log') return send(res, 200, { contract_version: CV, data: [], next_cursor: null });
    }
    const ack = p.match(/^\/api\/v1\/bookings\/([^/]+)\/ack$/);
    if (ack && req.method === 'POST') {
      const b = state.bookings.get(ack[1]);
      if (!b) return err(res, 404, 'not_found', 'Unknown booking');
      state.acks.push({ booking_id: ack[1], ...body });
      state.acked.add(`${ack[1]}|${body.revision_id}`);
      return send(res, 200, { contract_version: CV, data: { booking_id: ack[1], revision_id: body.revision_id, acked_at: nowZ() } });
    }
    return err(res, 404, 'not_found', `No route ${req.method} ${p}`);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      res.writeHead(500);
      res.end(JSON.stringify({ error: { code: 'internal_error', message: e.message } }));
    });
  });

  return {
    state,
    listen(port = 0) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
        state.baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve(state.baseUrl);
      }));
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

module.exports = { createMock };

if (require.main === module) {
  const mock = createMock();
  mock.listen(Number(process.argv[2]) || 4010).then((u) => console.log(`mock M-Channel on ${u}, pairing code ${mock.state.code}`));
}
