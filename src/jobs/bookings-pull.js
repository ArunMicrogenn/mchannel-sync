'use strict';
// Pull fallback (spec 8.2): GET /properties/:id/bookings?since=...
// Runs on start-up and every BOOKING_PULL_MINUTES as a safety net next to the
// webhooks. Each run does two passes:
//   1. everything changed since the last pull (minus an overlap)
//   2. only_unacked=true for the last BOOKING_BACKFILL_DAYS, so bookings that
//      M-Channel still shows as "not in PMS" get stored and acked again.

const config = require('../config');
const db = require('../lib/db');
const log = require('../lib/logger');
const { clientFor } = require('../lib/properties');
const { importBooking } = require('../lib/booking-import');
const { utcStamp } = require('../lib/dates');
const { withRunLog } = require('./run-log');

async function pullPages(client, property, query, { forceAck }) {
  const counts = { seen: 0, created: 0, updated: 0, stale: 0, duplicate: 0, reack: 0, errors: 0 };
  let cursor;
  let pages = 0;
  do {
    const res = await client.pullBookings(property.id, { ...query, limit: 100, cursor });
    const list = Array.isArray(res.data) ? res.data : [];
    for (const b of list) {
      counts.seen++;
      try {
        const r = await db.tx((c) => importBooking(c, property, b, { source: 'pull', forceAck }));
        if (r.outcome === 'created') counts.created++;
        else if (r.outcome === 'updated') counts.updated++;
        else if (r.outcome === 'stale') counts.stale++;
        else if (r.outcome === 'duplicate_reack') counts.reack++;
        else counts.duplicate++;
      } catch (err) {
        counts.errors++;
        log.error('pulled booking not saved', { property_id: property.id, booking_id: b && b.id, err });
      }
    }
    cursor = res.body && res.body.next_cursor;
    pages++;
  } while (cursor && pages < 1000);
  return counts;
}

async function pullBookings(property) {
  return withRunLog(property.id, 'bookings', async () => {
    const client = clientFor(property);
    const startedAt = new Date();
    const sinceBase = property.booking_cursor
      ? new Date(new Date(property.booking_cursor).getTime() - config.bookingOverlapSeconds * 1000)
      : new Date(Date.now() - config.bookingBackfillDays * 86400000);

    const changed = await pullPages(client, property, { since: utcStamp(sinceBase) }, { forceAck: false });
    const unacked = await pullPages(
      client, property,
      { since: utcStamp(Date.now() - config.bookingBackfillDays * 86400000), only_unacked: 'true' },
      { forceAck: true },
    );

    // Move the cursor only when every booking of the first pass was saved.
    if (changed.errors === 0) {
      await db.query(
        'UPDATE properties SET booking_cursor = $2, bookings_pulled_at = now(), updated_at = now() WHERE id = $1',
        [property.id, startedAt],
      );
    } else {
      await db.query('UPDATE properties SET bookings_pulled_at = now() WHERE id = $1', [property.id]);
    }

    const fmt = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
    return { items: changed.seen + unacked.seen, detail: `changed: ${fmt(changed)}; unacked: ${fmt(unacked)}` };
  });
}

module.exports = { pullBookings };
