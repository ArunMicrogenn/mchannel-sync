'use strict';
// Sends POST /bookings/:id/ack for every revision that needs one (spec 8).
// Durable: the ack lives in booking_revisions, so a restart or an M-Channel
// outage only delays it. The ack call is idempotent on M-Channel's side.

const db = require('../lib/db');
const log = require('../lib/logger');
const { getById, clientFor } = require('../lib/properties');
const { RETRYABLE } = require('../lib/mchannel-client');

const MAX_ATTEMPTS = 48; // about two days with the 1 h cap

function retryDelaySeconds(attempt, retryAfter) {
  if (retryAfter) return Math.min(Math.max(retryAfter, 1), 3600);
  return Math.min(30 * 2 ** Math.max(attempt - 1, 0), 3600); // 30 s, 1 min, 2 min ... 1 h
}

let inFlight = null;
let again = false;

async function resetStuck() {
  await db.query(`UPDATE booking_revisions SET ack_status = 'pending' WHERE ack_status = 'sending'`);
}

// One run at a time; a call during a run gets one more pass and waits for it.
function processAcks(opts = {}) {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = (async () => {
    const total = { sent: 0, retry: 0, failed: 0 };
    try {
      do {
        again = false;
        const c = await processAcksOnce(opts);
        total.sent += c.sent;
        total.retry += c.retry;
        total.failed += c.failed;
      } while (again);
    } finally {
      inFlight = null;
    }
    return total;
  })();
  return inFlight;
}

async function processAcksOnce({ limit = 50 } = {}) {
  const counts = { sent: 0, retry: 0, failed: 0 };
  {
    const { rows } = await db.query(
      `WITH due AS (
         SELECT revision_id FROM booking_revisions
         WHERE ack_status IN ('pending', 'error') AND ack_next_at <= now()
         ORDER BY ack_next_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE booking_revisions r SET ack_status = 'sending', ack_attempts = r.ack_attempts + 1
       FROM due WHERE r.revision_id = due.revision_id
       RETURNING r.revision_id, r.booking_id, r.property_id, r.ack_result, r.failure_reason, r.ack_attempts`,
      [limit],
    );
    const props = new Map();
    for (const rev of rows) {
      let property = props.get(rev.property_id);
      if (!property) {
        property = await getById(rev.property_id);
        props.set(rev.property_id, property);
      }
      const booking = (await db.query(
        'SELECT pms_booking_id, pms_booking_no, external_booking_id FROM bookings WHERE id = $1',
        [rev.booking_id],
      )).rows[0];
      if (!property || !booking) {
        await db.query(`UPDATE booking_revisions SET ack_status = 'skipped', ack_error = 'booking or property missing'
                        WHERE revision_id = $1`, [rev.revision_id]);
        continue;
      }

      const body = {
        revision_id: rev.revision_id,
        pms_booking_id: String(booking.external_booking_id || booking.pms_booking_id).slice(0, 100),
        pms_booking_no: booking.pms_booking_no || null,
        result: rev.ack_result,
      };
      if (rev.ack_result === 'failed') {
        body.pms_booking_id = booking.external_booking_id || '0';
        body.failure_reason = String(rev.failure_reason || 'Not imported').slice(0, 500);
      }

      try {
        const res = await clientFor(property, { maxAttempts: 1 }).ackBooking(rev.booking_id, body, { attempts: 1 });
        await db.tx(async (c) => {
          await c.query(
            `UPDATE booking_revisions SET ack_status = 'sent', acked_at = COALESCE($2::timestamptz, now()),
                    ack_error = NULL WHERE revision_id = $1`,
            [rev.revision_id, (res.data && res.data.acked_at) || null],
          );
          await c.query(
            `UPDATE bookings SET ack_status = $3, acked_revision_id = $2, acked_at = now()
             WHERE id = $1 AND revision_id = $2`,
            [rev.booking_id, rev.revision_id, rev.ack_result === 'failed' ? 'failed' : 'acked'],
          );
        });
        counts.sent++;
        log.info('booking acked', { booking_id: rev.booking_id, revision_id: rev.revision_id, result: rev.ack_result });
      } catch (err) {
        const summary = typeof err.summary === 'function' ? err.summary() : err.message;
        const retryable = err.status === undefined || RETRYABLE.has(err.status);
        if (retryable && rev.ack_attempts < MAX_ATTEMPTS) {
          const wait = retryDelaySeconds(rev.ack_attempts, err.retryAfter);
          await db.query(
            `UPDATE booking_revisions SET ack_status = 'error', ack_error = $2,
                    ack_next_at = now() + make_interval(secs => $3) WHERE revision_id = $1`,
            [rev.revision_id, summary, wait],
          );
          counts.retry++;
          log.warn('ack will be retried', { booking_id: rev.booking_id, wait_s: wait, err: summary });
        } else {
          await db.tx(async (c) => {
            await c.query(
              `UPDATE booking_revisions SET ack_status = 'failed', ack_error = $2 WHERE revision_id = $1`,
              [rev.revision_id, summary],
            );
            await c.query(
              `INSERT INTO alerts (property_id, kind, message, data) VALUES ($1, 'ack_failed', $2, $3)`,
              [rev.property_id, `Ack for booking ${rev.booking_id} was refused: ${summary}`,
                { booking_id: rev.booking_id, revision_id: rev.revision_id, body }],
            );
          });
          counts.failed++;
          log.error('ack failed permanently', { booking_id: rev.booking_id, err: summary });
        }
      }
    }
    return counts;
  }
}

module.exports = { processAcks, resetStuck, retryDelaySeconds };
