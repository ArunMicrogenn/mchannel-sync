#!/usr/bin/env node
'use strict';
// Command line for the VPS:  mchannel-sync <command> ...   (node src/cli.js <command>)

const fs = require('fs');
const config = require('./config');
const db = require('./lib/db');
const props = require('./lib/properties');
const pairing = require('./lib/pairing');
const { syncSetup } = require('./jobs/setup');
const { pullBookings } = require('./jobs/bookings-pull');
const { processAcks } = require('./jobs/ack-worker');
const { pushProperty, requestFullPush } = require('./jobs/ari-push');
const { todayIn, addDays } = require('./lib/dates');

const HELP = `mchannel-sync ${config.version}  (settings: ${config.envFile}${config.envFileLoaded ? '' : ' - NOT FOUND'})

 Hotels
  pair --code MCH-XXXX-XXXX --hotel hotel.json [--env staging|production]
                                       claim a pairing code from M-Channel > Connect a PMS
  connect --property-id <uuid> [--env production|staging] [--pms-hotel-id H001]
                                       connect with an API key you already have (asked for, not echoed);
                                       bookings are then fetched every BOOKING_PULL_MINUTES
  list                                 paired hotels, last booking fetch and last push
  show <hotel>                         room types, rate plans, mapping, last runs, open alerts
  enable <hotel> | disable <hotel>     start / stop syncing a hotel
  mappings <hotel> <file.json>         send a corrected mapping ({"mappings": [...]})

 Bookings (M-Channel -> Postgres)
  fetch <hotel|all>                    fetch bookings now
  bookings <hotel> [limit]             stored bookings, newest first
  acks                                 send pending acks now
  ack <booking-id> failed "<reason>"   tell M-Channel a booking could not be taken

 Inventory and rates (Postgres -> M-Channel)
  set-availability <hotel> <room> <from> <to> <free rooms>
  set-rate <hotel> <rate plan> <from> <to> <price> [occupancy]
  inventory <hotel> [from] [to]        free rooms in Postgres and whether they were sent
  rates <hotel> [from] [to]            prices / restrictions in Postgres and whether they were sent
  pending <hotel>                      rows waiting to be sent, recent push batches
  push <hotel|all>                     send waiting rows now
  push-full <hotel> [--force]          re-send every future row as one full sync (once a day)
  remote-ari <hotel> [from] [to]       what M-Channel currently holds (read only)

 Checks
  sync <hotel|all> [setup] [bookings]  run jobs now (default both)
  pairing-status <hotel> | remote-health <hotel> | sync-log <hotel> [level]
  migrate                              create / update the tables

<hotel> = PMS hotel id (e.g. H001), M-Channel code or property id.
<room> / <rate plan> = PMS code from the mapping (e.g. RT-1, RT-1|EP), M-Channel code or id.`;

function arg(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const print = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
const fmtTime = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '');
const errText = (err) => (typeof err.summary === 'function' ? err.summary() : err.message);

function table(rows, cols) {
  if (!rows.length) return print('(none)');
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  console.log(cols.map((c, i) => c.padEnd(w[i])).join('  '));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(cols.map((c, i) => String(r[c] ?? '').padEnd(w[i])).join('  '));
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = false;
    rl._writeToOutput = (str) => {
      if (!rl.stdoutMuted) rl.output.write(str);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
    rl.stdoutMuted = true;
  });
}

async function need(ref) {
  const p = await props.resolve(ref);
  if (!p) throw new Error(`No paired hotel matches "${ref}". Run: mchannel-sync list`);
  return p;
}

async function hotels(ref) {
  return ref === 'all' ? props.listEnabled() : [await need(ref)];
}

const JOBS = { setup: syncSetup, bookings: pullBookings };

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'migrate': {
      const applied = await db.migrate();
      print(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
      break;
    }
    case 'pair': {
      const code = arg(args, '--code');
      const file = arg(args, '--hotel');
      if (!code || !file) throw new Error('usage: pair --code MCH-XXXX-XXXX --hotel hotel.json [--env staging|production]');
      const setup = JSON.parse(fs.readFileSync(file, 'utf8'));
      const result = await pairing.claim({
        code, env: arg(args, '--env') || setup.env || 'staging', base_url: arg(args, '--base-url'),
        hotel: setup.hotel, room_types: setup.room_types, rate_plans: setup.rate_plans,
      });
      print(result);
      for (const job of ['setup', 'bookings']) {
        try {
          const r = await JOBS[job](await props.getById(result.property.id));
          console.log(`${job}: ok ${r.detail || ''}`);
        } catch (err) {
          console.log(`${job}: ${errText(err)}`);
        }
      }
      break;
    }
    case 'connect': {
      const key = process.env.MCHANNEL_API_KEY || await askHidden('M-Channel API key (X-MChannel-Key): ');
      const rec = await pairing.connectWithKey({
        propertyId: arg(args, '--property-id'), apiKey: key, env: arg(args, '--env') || 'production',
        base_url: arg(args, '--base-url'), pms_hotel_id: arg(args, '--pms-hotel-id'),
      });
      print({ connected: rec.name, property_id: rec.id, pms_hotel_id: rec.pms_hotel_id, env: rec.env, base_url: rec.base_url,
        rooms_from: rec.ari_source, prices_from: rec.rate_source });
      for (const job of ['setup', 'bookings']) {
        try {
          const r = await JOBS[job](await props.getById(rec.id));
          console.log(`${job}: ok ${r.detail || ''}`);
        } catch (err) {
          console.log(`${job}: ${errText(err)}`);
        }
      }
      print(await processAcks({ limit: 500 }));
      break;
    }
    case 'list': {
      const { rows } = await db.query('SELECT * FROM properties ORDER BY name');
      table(rows.map((p) => ({
        id: p.id, name: p.name, code: p.code, pms_hotel_id: p.pms_hotel_id, env: p.env, status: p.status,
        rooms_from: p.ari_source, prices_from: p.rate_source, enabled: p.is_enabled,
        bookings_fetched: fmtTime(p.bookings_pulled_at), last_push: fmtTime(p.ari_pushed_at),
      })), ['id', 'name', 'code', 'pms_hotel_id', 'env', 'status', 'rooms_from', 'prices_from', 'enabled', 'bookings_fetched', 'last_push']);
      break;
    }
    case 'show': {
      const p = await need(args[0]);
      print(props.publicView(p));
      const q = (sql) => db.query(sql, [p.id]).then((r) => r.rows);
      console.log('\nRoom types');
      table(await q('SELECT id, code, title, count_of_rooms, is_active FROM room_types WHERE property_id = $1 ORDER BY title'),
        ['id', 'code', 'title', 'count_of_rooms', 'is_active']);
      console.log('\nRate plans');
      table(await q('SELECT id, code, title, sell_mode, rate_mode, meal_type, room_type_id FROM rate_plans WHERE property_id = $1 ORDER BY title'),
        ['id', 'code', 'title', 'sell_mode', 'rate_mode', 'meal_type', 'room_type_id']);
      console.log('\nMapping (PMS code -> M-Channel id)');
      table(await q('SELECT pms_room_type_ref, pms_rate_plan_ref, room_type_id, rate_plan_id FROM mappings WHERE property_id = $1 ORDER BY 1, 2'),
        ['pms_room_type_ref', 'pms_rate_plan_ref', 'room_type_id', 'rate_plan_id']);
      console.log('\nLast runs');
      table((await q(`SELECT DISTINCT ON (job) job, started_at, ok, items, detail FROM sync_runs WHERE property_id = $1
                      ORDER BY job, started_at DESC`)).map((r) => ({ ...r, started_at: fmtTime(r.started_at) })),
      ['job', 'started_at', 'ok', 'items', 'detail']);
      console.log('\nOpen alerts');
      table((await q('SELECT id, kind, message, created_at FROM alerts WHERE property_id = $1 AND resolved_at IS NULL ORDER BY id DESC LIMIT 20'))
        .map((r) => ({ ...r, created_at: fmtTime(r.created_at) })), ['id', 'kind', 'created_at', 'message']);
      break;
    }
    case 'enable':
    case 'disable': {
      const p = await need(args[0]);
      await db.query('UPDATE properties SET is_enabled = $2, updated_at = now() WHERE id = $1', [p.id, cmd === 'enable']);
      print(`${p.name}: ${cmd}d`);
      break;
    }
    case 'mappings': {
      const p = await need(args[0]);
      const body = JSON.parse(fs.readFileSync(args[1], 'utf8'));
      const res = await props.clientFor(p).putMappings(p.id, body.mappings);
      await db.tx(async (c) => {
        await c.query('DELETE FROM mappings WHERE property_id = $1', [p.id]);
        for (const m of body.mappings) {
          if (!m.pms_room_type_ref || !m.room_type_id) continue;
          await c.query(`INSERT INTO mappings (property_id, pms_room_type_ref, pms_rate_plan_ref, room_type_id, rate_plan_id)
                         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [p.id, m.pms_room_type_ref, m.pms_rate_plan_ref || null, m.room_type_id, m.rate_plan_id || null]);
        }
      });
      print(res.body);
      break;
    }
    case 'fetch':
    case 'sync': {
      const jobs = cmd === 'fetch' ? ['bookings'] : (args.slice(1).length ? args.slice(1) : ['setup', 'bookings']);
      for (const p0 of await hotels(args[0])) {
        for (const job of jobs) {
          if (!JOBS[job]) throw new Error(`unknown job ${job} (setup | bookings)`);
          try {
            const r = await JOBS[job](await props.getById(p0.id));
            console.log(`${p0.name} ${job}: ok ${r.detail || ''}`);
          } catch (err) {
            console.log(`${p0.name} ${job}: FAILED ${errText(err)}`);
          }
        }
      }
      break;
    }
    case 'bookings': {
      const p = await need(args[0]);
      const { rows } = await db.query(
        `SELECT id, pms_booking_id, unique_id, status, revision_seq AS rev, arrival_date, departure_date,
                trim(coalesce(guest_first_name,'') || ' ' || coalesce(guest_last_name,'')) AS guest,
                room_count AS rooms, amount, currency, ack_status, updated_at
         FROM bookings WHERE property_id = $1 ORDER BY updated_at DESC LIMIT $2`, [p.id, Number(args[1]) || 30]);
      table(rows.map((r) => ({ ...r, updated_at: fmtTime(r.updated_at) })),
        ['id', 'pms_booking_id', 'unique_id', 'status', 'rev', 'arrival_date', 'departure_date', 'guest', 'rooms', 'amount', 'currency', 'ack_status', 'updated_at']);
      break;
    }
    case 'acks':
      print(await processAcks({ limit: 500 }));
      break;
    case 'ack': {
      const [bookingId, result, reason] = args;
      const { rows } = await db.query('SELECT ack_booking($1, $2, $3) AS r', [bookingId, result, reason || null]);
      print(rows[0].r);
      print(await processAcks({ limit: 50 }));
      break;
    }
    case 'set-availability': {
      const [ref, room, from, to, n] = args;
      const p = await need(ref);
      const { rows } = await db.query('SELECT set_availability($1, $2, $3, $4, $5) AS n', [p.id, room, from, to, Number(n)]);
      print(`${rows[0].n} day(s) written; sending...`);
      print(await pushProperty(p.id));
      break;
    }
    case 'set-rate': {
      const [ref, plan, from, to, price, occ] = args;
      const p = await need(ref);
      const { rows } = await db.query('SELECT set_rate($1, $2, $3, $4, $5, $6) AS n',
        [p.id, plan, from, to, price, Number(occ || 0)]);
      print(`${rows[0].n} day(s) written; sending...`);
      print(await pushProperty(p.id));
      break;
    }
    case 'inventory': {
      const p = await need(args[0]);
      const from = args[1] || todayIn(p.timezone);
      const to = args[2] || addDays(from, 13);
      const { rows } = await db.query(
        `SELECT coalesce(t.title, i.room_type_id::text) AS room_type, i.pms_room_type_ref AS pms_code, i.stay_date AS date,
                i.availability, CASE WHEN i.version > i.pushed_version THEN 'waiting' WHEN i.push_error IS NOT NULL THEN 'error'
                ELSE 'sent' END AS state, i.pushed_at, i.push_error
         FROM room_inventory i LEFT JOIN room_types t ON t.id = i.room_type_id
         WHERE i.property_id = $1 AND i.stay_date BETWEEN $2 AND $3 ORDER BY 1, i.stay_date`, [p.id, from, to]);
      table(rows.map((r) => ({ ...r, pushed_at: fmtTime(r.pushed_at) })), ['room_type', 'pms_code', 'date', 'availability', 'state', 'pushed_at', 'push_error']);
      break;
    }
    case 'rates': {
      const p = await need(args[0]);
      const from = args[1] || todayIn(p.timezone);
      const to = args[2] || addDays(from, 13);
      const { rows } = await db.query(
        `SELECT coalesce(rp.title, r.rate_plan_id::text) AS rate_plan, r.pms_rate_plan_ref AS pms_code, r.stay_date AS date,
                r.occupancy, r.rate, CASE WHEN r.version > r.pushed_version THEN 'waiting' WHEN r.push_error IS NOT NULL
                THEN 'error' ELSE 'sent' END AS state, r.push_error
         FROM room_rates r LEFT JOIN rate_plans rp ON rp.id = r.rate_plan_id
         WHERE r.property_id = $1 AND r.stay_date BETWEEN $2 AND $3 ORDER BY 1, r.stay_date, r.occupancy`, [p.id, from, to]);
      console.log('Prices');
      table(rows, ['rate_plan', 'pms_code', 'date', 'occupancy', 'rate', 'state', 'push_error']);
      const rs = await db.query(
        `SELECT coalesce(rp.title, s.rate_plan_id::text) AS rate_plan, s.stay_date AS date, s.min_stay_arrival AS min_stay,
                s.max_stay, s.closed_to_arrival AS cta, s.closed_to_departure AS ctd, s.stop_sell,
                CASE WHEN s.version > s.pushed_version THEN 'waiting' WHEN s.push_error IS NOT NULL THEN 'error' ELSE 'sent' END AS state
         FROM rate_restrictions s LEFT JOIN rate_plans rp ON rp.id = s.rate_plan_id
         WHERE s.property_id = $1 AND s.stay_date BETWEEN $2 AND $3 ORDER BY 1, s.stay_date`, [p.id, from, to]);
      console.log('\nRestrictions');
      table(rs.rows, ['rate_plan', 'date', 'min_stay', 'max_stay', 'cta', 'ctd', 'stop_sell', 'state']);
      break;
    }
    case 'pending': {
      const p = await need(args[0]);
      const { rows } = await db.query(
        `SELECT 'room_inventory' AS tbl, count(*) FILTER (WHERE version > pushed_version) AS waiting,
                count(*) FILTER (WHERE push_error IS NOT NULL) AS errors FROM room_inventory WHERE property_id = $1
         UNION ALL SELECT 'room_rates', count(*) FILTER (WHERE version > pushed_version), count(*) FILTER (WHERE push_error IS NOT NULL)
           FROM room_rates WHERE property_id = $1
         UNION ALL SELECT 'rate_restrictions', count(*) FILTER (WHERE version > pushed_version), count(*) FILTER (WHERE push_error IS NOT NULL)
           FROM rate_restrictions WHERE property_id = $1`, [p.id]);
      table(rows, ['tbl', 'waiting', 'errors']);
      console.log(`\nrooms from: ${p.ari_source}   prices from: ${p.rate_source}  (only the "pms" parts are sent)`);
      const b = await db.query(
        `SELECT id, sync_type, item_count AS items, row_count AS rows, status, attempts, http_status, created_at, error
         FROM ari_batches WHERE property_id = $1 ORDER BY id DESC LIMIT 10`, [p.id]);
      console.log('\nRecent push batches');
      table(b.rows.map((r) => ({ ...r, created_at: fmtTime(r.created_at) })), ['id', 'sync_type', 'items', 'rows', 'status', 'attempts', 'http_status', 'created_at', 'error']);
      break;
    }
    case 'push': {
      for (const p of await hotels(args[0])) {
        console.log(`${p.name}: ${JSON.stringify(await pushProperty(p.id))}`);
      }
      break;
    }
    case 'push-full': {
      const p = await need(args[0]);
      print(await requestFullPush(p, { force: args.includes('--force') }));
      print(await pushProperty(p.id));
      break;
    }
    case 'remote-ari': {
      const p = await need(args[0]);
      const from = args[1] || todayIn(p.timezone);
      const to = args[2] || addDays(from, 13);
      const d = (await props.clientFor(p).readAri(p.id, { date_from: from, date_to: to })).data || {};
      console.log(`ari_source=${d.ari_source} rate_source=${d.rate_source} currency=${d.currency}\n\nAvailability`);
      table((d.availability || []).map((a) => ({ pms_code: a.pms_room_type_ref, room_type_id: a.room_type_id, date: a.date, availability: a.availability, updated_at: a.updated_at })),
        ['pms_code', 'room_type_id', 'date', 'availability', 'updated_at']);
      console.log('\nRates');
      table((d.rates || []).map((r) => ({ pms_code: r.pms_rate_plan_ref, rate_plan_id: r.rate_plan_id, date: r.date, occ: r.occupancy, rate: r.rate, min_stay: r.min_stay_arrival, stop_sell: r.stop_sell })),
        ['pms_code', 'rate_plan_id', 'date', 'occ', 'rate', 'min_stay', 'stop_sell']);
      break;
    }
    case 'pairing-status': {
      const p = await need(args[0]);
      print((await props.clientFor(p).pairingStatus(p.id)).body);
      break;
    }
    case 'remote-health': {
      const p = await need(args[0]);
      print((await props.clientFor(p).health(p.id)).body);
      break;
    }
    case 'sync-log': {
      const p = await need(args[0]);
      print((await props.clientFor(p).syncLog(p.id, { level: args[1], limit: 50 })).body);
      break;
    }
    default:
      print(HELP);
  }
}

main()
  .catch((err) => {
    console.error(`error: ${errText(err)}`);
    process.exitCode = 1;
  })
  .finally(() => db.close());
