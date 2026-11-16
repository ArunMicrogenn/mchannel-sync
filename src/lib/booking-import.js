'use strict';
// Saves one booking revision (webhook or pull) into Postgres.
//  - idempotent on revision_id (the same revision may arrive twice)
//  - ordered by revision_seq (an older revision arriving late is kept in
//    booking_revisions but not applied)
//  - a modification carries the complete new state, so rooms are replaced
//  - queues the ack the spec requires after the database commit

const config = require('../config');

class BookingInputError extends Error {}

function ackResultFor(status) {
  if (status === 'new') return 'imported';
  if (status === 'cancelled') return 'cancelled';
  return 'updated';
}

function money(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
}

function validate(b) {
  if (!b || typeof b !== 'object') throw new BookingInputError('booking object missing');
  for (const f of ['id', 'revision_id']) {
    if (typeof b[f] !== 'string' || !b[f]) throw new BookingInputError(`booking.${f} missing`);
  }
  if (!Number.isInteger(b.revision_seq)) throw new BookingInputError('booking.revision_seq missing');
  if (!['new', 'modified', 'cancelled'].includes(b.status)) {
    throw new BookingInputError(`booking.status "${b.status}" unknown`);
  }
}

/**
 * @param c         pg client inside a transaction
 * @param property  properties row
 * @param b         Booking object (spec 7.3)
 * @param opts      { source: 'webhook'|'pull', eventId, forceAck }
 */
async function importBooking(c, property, b, { source, eventId = null, forceAck = false } = {}) {
  validate(b);
  if (b.property_id && b.property_id !== property.id) {
    throw new BookingInputError(`booking belongs to property ${b.property_id}, not ${property.id}`);
  }
  const autoAck = config.ackMode === 'auto';

  // One writer per booking at a time.
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [b.id]);

  const cur = (await c.query(
    'SELECT revision_id, revision_seq, pms_booking_id FROM bookings WHERE id = $1', [b.id],
  )).rows[0];

  const seen = (await c.query(
    'SELECT ack_status FROM booking_revisions WHERE revision_id = $1', [b.revision_id],
  )).rows[0];

  if (seen) {
    // Same revision again. If M-Channel still thinks it is not in the PMS
    // (hotel pressed Re-send, or it is in the unacked list), ack it again.
    const isCurrent = cur && cur.revision_id === b.revision_id;
    if (isCurrent && autoAck && (forceAck || seen.ack_status === 'error') && seen.ack_status !== 'pending') {
      await c.query(
        `UPDATE booking_revisions SET ack_status = 'pending', ack_next_at = now(), ack_error = NULL
         WHERE revision_id = $1`,
        [b.revision_id],
      );
      return { outcome: 'duplicate_reack', pmsBookingId: cur.pms_booking_id };
    }
    return { outcome: 'duplicate', pmsBookingId: cur ? cur.pms_booking_id : null };
  }

  const stale = !!cur && cur.revision_seq >= b.revision_seq;
  await c.query(
    `INSERT INTO booking_revisions (revision_id, booking_id, property_id, revision_seq, status, source,
                                    event_id, applied, payload, ack_status, ack_result)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [b.revision_id, b.id, property.id, b.revision_seq, b.status, source, eventId, !stale, b,
      stale ? 'skipped' : autoAck ? 'pending' : 'hold', ackResultFor(b.status)],
  );
  if (stale) {
    return { outcome: 'stale', currentSeq: cur.revision_seq, pmsBookingId: cur.pms_booking_id };
  }

  const g = b.guest || {};
  const occ = b.occupancy || {};
  const pay = b.payment || {};
  const rooms = Array.isArray(b.rooms) ? b.rooms : [];

  const up = await c.query(
    `INSERT INTO bookings (id, property_id, revision_id, revision_seq, status, ota_code, ota_name,
        secondary_ota_name, ota_reservation_code, unique_id, arrival_date, departure_date, arrival_time,
        booked_at, received_at, currency, amount, ota_commission, guest_first_name, guest_last_name,
        guest_email, guest_phone, guest_country, guest_city, guest, adults, children, infants, room_count,
        payment_collect, payment_type, payment, notes, cancellation_policy_text, services, is_unmapped, raw,
        updated_at, cancelled_at, ack_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
             $26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37, now(),
             CASE WHEN $5 = 'cancelled' THEN now() END, $38)
     ON CONFLICT (id) DO UPDATE SET
        revision_id = EXCLUDED.revision_id, revision_seq = EXCLUDED.revision_seq, status = EXCLUDED.status,
        ota_code = EXCLUDED.ota_code, ota_name = EXCLUDED.ota_name,
        secondary_ota_name = EXCLUDED.secondary_ota_name, ota_reservation_code = EXCLUDED.ota_reservation_code,
        unique_id = EXCLUDED.unique_id, arrival_date = EXCLUDED.arrival_date,
        departure_date = EXCLUDED.departure_date, arrival_time = EXCLUDED.arrival_time,
        booked_at = EXCLUDED.booked_at, received_at = EXCLUDED.received_at, currency = EXCLUDED.currency,
        amount = EXCLUDED.amount, ota_commission = EXCLUDED.ota_commission,
        guest_first_name = EXCLUDED.guest_first_name, guest_last_name = EXCLUDED.guest_last_name,
        guest_email = EXCLUDED.guest_email, guest_phone = EXCLUDED.guest_phone,
        guest_country = EXCLUDED.guest_country, guest_city = EXCLUDED.guest_city, guest = EXCLUDED.guest,
        adults = EXCLUDED.adults, children = EXCLUDED.children, infants = EXCLUDED.infants,
        room_count = EXCLUDED.room_count, payment_collect = EXCLUDED.payment_collect,
        payment_type = EXCLUDED.payment_type, payment = EXCLUDED.payment, notes = EXCLUDED.notes,
        cancellation_policy_text = EXCLUDED.cancellation_policy_text, services = EXCLUDED.services,
        is_unmapped = EXCLUDED.is_unmapped, raw = EXCLUDED.raw, updated_at = now(),
        cancelled_at = CASE WHEN EXCLUDED.status = 'cancelled'
                            THEN COALESCE(bookings.cancelled_at, now()) ELSE NULL END,
        ack_status = EXCLUDED.ack_status
     RETURNING pms_booking_id, pms_booking_no`,
    [
      b.id, property.id, b.revision_id, b.revision_seq, b.status, b.ota_code ?? null, b.ota_name ?? null,
      b.secondary_ota_name ?? null, b.ota_reservation_code ?? null, b.unique_id ?? null,
      b.arrival_date ?? null, b.departure_date ?? null, b.arrival_time ?? null, b.booked_at ?? null,
      b.received_at ?? null, b.currency ?? null, money(b.amount), money(b.ota_commission),
      g.first_name ?? null, g.last_name ?? null, g.email ?? null, g.phone ?? null, g.country ?? null,
      g.city ?? null, JSON.stringify(g), occ.adults ?? null, occ.children ?? null, occ.infants ?? null,
      rooms.length, pay.collect ?? null, pay.type ?? null, JSON.stringify(pay), b.notes ?? null,
      b.cancellation_policy_text ?? null, JSON.stringify(b.services || []), !!b.is_unmapped,
      JSON.stringify(b), autoAck ? 'pending' : 'hold',
    ],
  );

  await c.query('DELETE FROM booking_rooms WHERE booking_id = $1', [b.id]);
  if (rooms.length) {
    await c.query(
      `WITH src AS (
         SELECT e.room, e.idx::int AS idx
         FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS e(room, idx)
       ), ins AS (
         INSERT INTO booking_rooms (booking_id, property_id, room_index, room_type_id, rate_plan_id,
            pms_room_type_ref, pms_rate_plan_ref, ota_room_code, ota_rate_code, ota_room_unique_id,
            checkin_date, checkout_date, adults, children, infants, guests, amount, taxes, services,
            meal_plan, is_cancelled)
         SELECT $1, $2, src.idx,
                NULLIF(src.room->>'room_type_id', '')::uuid, NULLIF(src.room->>'rate_plan_id', '')::uuid,
                src.room->>'pms_room_type_ref', src.room->>'pms_rate_plan_ref',
                src.room->>'ota_room_code', src.room->>'ota_rate_code', src.room->>'ota_room_unique_id',
                NULLIF(src.room->>'checkin_date', '')::date, NULLIF(src.room->>'checkout_date', '')::date,
                (src.room->'occupancy'->>'adults')::int, (src.room->'occupancy'->>'children')::int,
                (src.room->'occupancy'->>'infants')::int,
                COALESCE(src.room->'guests', '[]'::jsonb), NULLIF(src.room->>'amount', '')::numeric,
                COALESCE(src.room->'taxes', '[]'::jsonb), COALESCE(src.room->'services', '[]'::jsonb),
                src.room->>'meal_plan', COALESCE((src.room->>'is_cancelled')::boolean, false)
         FROM src
         RETURNING id, room_index, room_type_id
       )
       INSERT INTO booking_room_nights (booking_room_id, booking_id, property_id, room_type_id, stay_date, amount)
       SELECT ins.id, $1, $2, ins.room_type_id, (n->>'date')::date, NULLIF(n->>'amount', '')::numeric
       FROM ins
       JOIN src ON src.idx = ins.room_index
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(src.room->'nightly_prices') = 'array' THEN src.room->'nightly_prices'
              ELSE '[]'::jsonb END) AS n
       WHERE n->>'date' IS NOT NULL
       ON CONFLICT DO NOTHING`,
      [b.id, property.id, JSON.stringify(rooms)],
    );
  }

  // Older revisions still waiting for an ack are superseded by this one.
  await c.query(
    `UPDATE booking_revisions SET ack_status = 'skipped'
     WHERE booking_id = $1 AND revision_id <> $2 AND ack_status IN ('pending', 'error', 'hold')`,
    [b.id, b.revision_id],
  );

  if (b.is_unmapped) {
    await c.query(
      `INSERT INTO alerts (property_id, kind, message, data) VALUES ($1, 'booking_unmapped', $2, $3)`,
      [property.id, `Booking ${b.unique_id || b.id} has a room or rate that is not mapped; saved as unallocated`,
        { booking_id: b.id, revision_id: b.revision_id, unique_id: b.unique_id }],
    );
  }

  return {
    outcome: cur ? 'updated' : 'created',
    pmsBookingId: up.rows[0].pms_booking_id,
    pmsBookingNo: up.rows[0].pms_booking_no,
  };
}

module.exports = { importBooking, ackResultFor, BookingInputError };
