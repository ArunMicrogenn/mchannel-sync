'use strict';
// POST /mchannel/webhook/:token   (spec 7)
//  1. raw body, before any JSON parsing
//  2. reject a timestamp more than 300 s from our clock
//  3. HMAC-SHA256(secret, timestamp + "." + raw body), constant-time compare
//  4. an event id already processed -> 200, nothing else
//  5. save, then reply 2xx within 10 s; the ack is sent right after by the ack worker

const express = require('express');
const config = require('../config');
const db = require('../lib/db');
const log = require('../lib/logger');
const { decrypt, safeEqual, webhookSignature } = require('../lib/crypto');
const { importBooking, BookingInputError } = require('../lib/booking-import');

const BOOKING_EVENTS = new Set(['booking.created', 'booking.modified', 'booking.cancelled']);
const ALERT_EVENTS = {
  'ari.rejected': (d) => `OTA network refused part of ARI batch ${d.batch_id || ''} (${(d.rejected || []).length} item(s))`,
  'channel.disconnected': (d) => `OTA connection ${d.title || d.ota_code || ''} ${d.reason || 'disconnected'}${d.expected_removal_date ? ', removal ' + d.expected_removal_date : ''}${d.message ? ': ' + d.message : ''}`,
  'mapping.required': (d) => `Mapping required (${d.scope || 'unknown'})${d.message ? ': ' + d.message : ''}`,
};

// token -> property (secret decrypted), cached for a minute
const cache = new Map();
async function propertyForToken(token) {
  const hit = cache.get(token);
  if (hit && hit.until > Date.now()) return hit.value;
  const { rows } = await db.query('SELECT * FROM properties WHERE webhook_token = $1 AND is_enabled', [token]);
  let value = rows[0] ? { property: rows[0], secret: decrypt(rows[0].webhook_secret_enc) } : null;
  if (value && !value.secret) value = null; // connected with an API key only: no webhook, bookings are fetched
  cache.set(token, { value, until: Date.now() + 60000 });
  return value;
}

function reply(res, status, message, extra) {
  const body = JSON.stringify({ ok: status < 300, message: String(message).slice(0, 400), ...extra });
  res.status(status).type('application/json').send(body.slice(0, 500));
}

function createWebhookRouter({ onBookingSaved } = {}) {
  const router = express.Router();

  router.post('/mchannel/webhook/:token', express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
    const started = Date.now();
    try {
      const found = await propertyForToken(req.params.token);
      if (!found) return reply(res, 404, 'unknown webhook');
      const { property, secret } = found;

      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const ts = req.get('X-MChannel-Timestamp') || '';
      const sig = (req.get('X-MChannel-Signature') || '').trim().toLowerCase();
      const headerEventId = req.get('X-MChannel-Event-Id') || '';

      if (!/^\d+$/.test(ts) || Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > config.webhookToleranceSeconds) {
        log.warn('webhook rejected: timestamp outside window', { property_id: property.id, ts });
        return reply(res, 401, 'timestamp outside the allowed window');
      }
      const expected = webhookSignature(secret, ts, raw);
      if (!sig || !safeEqual(expected, sig)) {
        log.warn('webhook rejected: bad signature', { property_id: property.id, event_id: headerEventId });
        return reply(res, 401, 'invalid signature');
      }

      let event;
      try {
        event = JSON.parse(raw.toString('utf8'));
      } catch (_) {
        return reply(res, 400, 'body is not valid JSON');
      }
      if (!event || typeof event !== 'object' || !event.event_id || !event.event) {
        return reply(res, 400, 'event or event_id missing');
      }
      const major = String(event.contract_version || '1').split('.')[0];
      if (major !== '1') return reply(res, 400, `version_unsupported: ${event.contract_version}`);
      if (headerEventId && headerEventId !== event.event_id) {
        return reply(res, 400, 'X-MChannel-Event-Id does not match event_id');
      }
      if (event.property_id && event.property_id !== property.id) {
        return reply(res, 403, 'event is for another property');
      }

      const outcome = await db.tx(async (c) => {
        const ins = await c.query(
          `INSERT INTO webhook_events (event_id, property_id, event, occurred_at, payload)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
          [event.event_id, property.id, event.event, event.occurred_at || null, event],
        );
        if (!ins.rowCount) return { status: 'duplicate' };

        let result;
        if (BOOKING_EVENTS.has(event.event)) {
          const b = event.data && event.data.booking;
          // A Re-send from M-Channel has a new event id: if we already hold
          // this revision, ack it again.
          const r = await importBooking(c, property, b, { source: 'webhook', eventId: event.event_id, forceAck: true });
          result = { status: r.outcome, booking: b, pmsBookingId: r.pmsBookingId };
        } else if (ALERT_EVENTS[event.event]) {
          const d = event.data || {};
          await c.query(
            'INSERT INTO alerts (property_id, kind, message, data) VALUES ($1, $2, $3, $4)',
            [property.id, event.event, ALERT_EVENTS[event.event](d), d],
          );
          result = { status: 'alert' };
        } else {
          result = { status: 'ignored' }; // unknown event types are stored and acknowledged
        }
        await c.query('UPDATE webhook_events SET result = $2 WHERE event_id = $1', [event.event_id, result.status]);
        return result;
      });

      let message;
      if (outcome.status === 'duplicate') message = 'duplicate event, already processed';
      else if (outcome.booking) {
        const label = outcome.booking.unique_id || outcome.booking.id;
        message = outcome.status === 'stale'
          ? `older revision ${outcome.booking.revision_seq} of ${label} ignored`
          : `${outcome.status} ${label} as ${outcome.pmsBookingId}`;
      } else message = `${event.event} ${outcome.status}`;

      log.info('webhook processed', {
        property_id: property.id, event: event.event, event_id: event.event_id, result: outcome.status,
        ms: Date.now() - started,
      });
      reply(res, 200, message);
      if (outcome.booking && onBookingSaved) setImmediate(onBookingSaved);
    } catch (err) {
      if (err instanceof BookingInputError) {
        log.error('webhook booking invalid', { err });
        return reply(res, 422, err.message);
      }
      log.error('webhook processing failed', { err });
      // 5xx -> M-Channel retries with backoff
      if (!res.headersSent) reply(res, 500, 'temporary error, please retry');
    }
  });

  return router;
}

function clearCache() {
  cache.clear();
}

module.exports = { createWebhookRouter, clearCache };
