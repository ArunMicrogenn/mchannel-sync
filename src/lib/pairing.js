'use strict';
// One-time pairing (spec 4): POST /api/v1/pairing/claim with the code the hotel
// user got from "Connect a PMS" in M-Channel. The response holds the API key
// and webhook secret, shown only once, so they are encrypted and stored
// immediately (and kept in an encrypted rescue file if the database write fails).

const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('./db');
const log = require('./logger');
const { encrypt, randomToken } = require('./crypto');
const { MChannelClient } = require('./mchannel-client');

class PairingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function webhookUrlFor(token) {
  if (!config.publicBaseUrl || !config.publicBaseUrl.startsWith('https://')) {
    throw new PairingError(400, 'PUBLIC_BASE_URL must be set to the https:// address of this service before pairing');
  }
  return `${config.publicBaseUrl}/mchannel/webhook/${token}`;
}

async function claim({ code, env = 'staging', hotel, room_types, rate_plans, base_url }) {
  if (typeof code !== 'string' || code.trim().length < 6 || code.trim().length > 32) {
    throw new PairingError(400, 'code must be the 6-32 character one-time code from M-Channel, e.g. MCH-7F3K-92QD');
  }
  if (!['staging', 'production'].includes(env)) throw new PairingError(400, 'env must be staging or production');
  if (!hotel || !hotel.pms_hotel_id || !hotel.name) {
    throw new PairingError(400, 'hotel.pms_hotel_id and hotel.name are required');
  }

  const baseUrl = (base_url || config.baseUrls[env]).replace(/\/+$/, '');
  const webhookToken = randomToken(24);
  const body = {
    code: code.trim(),
    pms: { name: config.pmsName, version: config.pmsVersion, instance_url: config.publicBaseUrl || undefined },
    webhook_url: webhookUrlFor(webhookToken),
    hotel,
  };
  if (Array.isArray(room_types) && room_types.length) body.room_types = room_types;
  if (Array.isArray(rate_plans) && rate_plans.length) body.rate_plans = rate_plans;

  const client = new MChannelClient({ baseUrl });
  const res = await client.claimPairing(body);
  const d = res.data || {};
  if (!d.api_key || !d.webhook_secret || !d.property || !d.property.id) {
    throw new PairingError(502, 'Pairing response is missing api_key, webhook_secret or property.id');
  }

  const record = {
    id: d.property.id,
    env,
    base_url: (d.base_url || baseUrl).replace(/\/+$/, ''),
    pms_hotel_id: String(hotel.pms_hotel_id),
    code: d.property.code || null,
    name: d.property.name || hotel.name,
    status: d.property.status || null,
    ari_source: d.property.ari_source || null,
    rate_source: d.property.rate_source || null,
    currency: hotel.currency || null,
    timezone: hotel.timezone || 'Asia/Kolkata',
    pairing_mode: d.mode || null,
    api_key_enc: encrypt(d.api_key),
    webhook_secret_enc: encrypt(d.webhook_secret),
    webhook_token: webhookToken,
  };
  const rawSafe = { ...d, api_key: undefined, webhook_secret: undefined };

  try {
    await db.tx(async (c) => {
      await c.query(
        `INSERT INTO properties (id, env, base_url, pms_hotel_id, code, name, status, ari_source, rate_source,
            currency, timezone, pairing_mode, api_key_enc, webhook_secret_enc, webhook_token,
            is_enabled, raw, paired_at, setup_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, true, $16, now(), NULL)
         ON CONFLICT (id) DO UPDATE SET
           env = EXCLUDED.env, base_url = EXCLUDED.base_url, pms_hotel_id = EXCLUDED.pms_hotel_id,
           code = EXCLUDED.code, name = EXCLUDED.name, status = EXCLUDED.status,
           ari_source = EXCLUDED.ari_source, rate_source = EXCLUDED.rate_source,
           currency = COALESCE(EXCLUDED.currency, properties.currency), timezone = EXCLUDED.timezone,
           pairing_mode = EXCLUDED.pairing_mode, api_key_enc = EXCLUDED.api_key_enc,
           webhook_secret_enc = EXCLUDED.webhook_secret_enc, webhook_token = EXCLUDED.webhook_token,
           is_enabled = true, raw = EXCLUDED.raw, paired_at = now(), setup_synced_at = NULL, updated_at = now()`,
        [record.id, record.env, record.base_url, record.pms_hotel_id, record.code, record.name, record.status,
          record.ari_source, record.rate_source, record.currency, record.timezone, record.pairing_mode,
          record.api_key_enc, record.webhook_secret_enc, record.webhook_token, rawSafe],
      );
      await c.query('DELETE FROM mappings WHERE property_id = $1', [record.id]);
      for (const m of d.mappings || []) {
        if (!m.pms_room_type_ref || !m.room_type_id) continue;
        await c.query(
          `INSERT INTO mappings (property_id, pms_room_type_ref, pms_rate_plan_ref, room_type_id, rate_plan_id)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [record.id, m.pms_room_type_ref, m.pms_rate_plan_ref || null, m.room_type_id, m.rate_plan_id || null],
        );
      }
    });
  } catch (err) {
    // The key and secret are never shown again: keep an encrypted copy.
    const file = path.join(config.dataDir, `pairing-rescue-${record.id}-${Date.now()}.enc`);
    try {
      fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, encrypt(JSON.stringify({ record, response: d })), { mode: 0o600 });
      log.error('pairing saved to rescue file because the database write failed', { file, err });
    } catch (e2) {
      log.error('pairing rescue file could not be written', { err: e2 });
    }
    throw err;
  }

  log.info('property paired', { property_id: record.id, name: record.name, env, mode: d.mode });
  return {
    property: {
      id: record.id, name: record.name, code: record.code, env, status: record.status,
      ari_source: record.ari_source, rate_source: record.rate_source, base_url: record.base_url,
    },
    mode: d.mode,
    mappings: d.mappings || [],
    unmatched: d.unmatched || {},
    filled_fields: d.filled_fields || [],
    next_steps: d.next_steps || [],
    webhook_url: body.webhook_url,
  };
}

// Connect a hotel with an API key it already has (no pairing code). There is
// no webhook secret then, so bookings come only through the 2-minute fetch.
async function connectWithKey({ propertyId, apiKey, env = 'production', base_url, pms_hotel_id, webhook_secret, timezone }) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(String(propertyId || ''))) throw new PairingError(400, '--property-id must be the M-Channel property id (uuid)');
  if (!apiKey || String(apiKey).trim().length < 8) throw new PairingError(400, 'API key missing');
  if (!['staging', 'production'].includes(env)) throw new PairingError(400, 'env must be staging or production');
  const baseUrl = (base_url || config.baseUrls[env]).replace(/\/+$/, '');
  const client = new MChannelClient({ baseUrl, apiKey: String(apiKey).trim() });
  const res = await client.listProperties();
  const remote = (res.data || []).find((x) => x.id === propertyId);
  if (!remote) {
    const seen = (res.data || []).map((x) => `${x.id} (${x.name})`).join(', ') || 'none';
    throw new PairingError(404, `This key does not list property ${propertyId} on ${baseUrl}. It lists: ${seen}`);
  }
  const rec = {
    id: remote.id, env, base_url: baseUrl, pms_hotel_id: String(pms_hotel_id || remote.code || remote.id),
    code: remote.code || null, name: remote.name, status: remote.status || null,
    ari_source: remote.ari_source || null, rate_source: remote.rate_source || null, currency: remote.currency || null,
    timezone: timezone || remote.timezone || 'Asia/Kolkata',
  };
  await db.query(
    `INSERT INTO properties (id, env, base_url, pms_hotel_id, code, name, status, ari_source, rate_source, currency,
        timezone, pairing_mode, api_key_enc, webhook_secret_enc, webhook_token, is_enabled, raw, paired_at, setup_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'api_key',$12,$13,$14,true,$15,now(),NULL)
     ON CONFLICT (id) DO UPDATE SET
       env = EXCLUDED.env, base_url = EXCLUDED.base_url, pms_hotel_id = EXCLUDED.pms_hotel_id, code = EXCLUDED.code,
       name = EXCLUDED.name, status = EXCLUDED.status, ari_source = EXCLUDED.ari_source, rate_source = EXCLUDED.rate_source,
       currency = COALESCE(EXCLUDED.currency, properties.currency), timezone = EXCLUDED.timezone,
       pairing_mode = 'api_key', api_key_enc = EXCLUDED.api_key_enc, webhook_secret_enc = EXCLUDED.webhook_secret_enc,
       webhook_token = EXCLUDED.webhook_token, is_enabled = true, raw = EXCLUDED.raw, setup_synced_at = NULL,
       updated_at = now()`,
    [rec.id, rec.env, rec.base_url, rec.pms_hotel_id, rec.code, rec.name, rec.status, rec.ari_source, rec.rate_source,
      rec.currency, rec.timezone, encrypt(String(apiKey).trim()), encrypt(webhook_secret || ''), randomToken(24), remote],
  );
  log.info('property connected with an API key', { property_id: rec.id, name: rec.name, env });
  return rec;
}

module.exports = { claim, connectWithKey, PairingError };
