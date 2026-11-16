'use strict';
const db = require('./db');
const { decrypt } = require('./crypto');
const { MChannelClient } = require('./mchannel-client');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function listEnabled() {
  const { rows } = await db.query('SELECT * FROM properties WHERE is_enabled ORDER BY name');
  return rows;
}

async function getById(id) {
  if (!UUID_RE.test(String(id))) return null;
  const { rows } = await db.query('SELECT * FROM properties WHERE id = $1', [id]);
  return rows[0] || null;
}

// Accepts the M-Channel property id, the PMS hotel id or the M-Channel code.
async function resolve(ref) {
  if (!ref) return null;
  const byId = await getById(ref);
  if (byId) return byId;
  const { rows } = await db.query(
    `SELECT * FROM properties WHERE pms_hotel_id = $1 OR lower(code) = lower($1)
     ORDER BY is_enabled DESC, paired_at DESC`,
    [ref],
  );
  return rows[0] || null;
}

function clientFor(property, opts) {
  return new MChannelClient({ baseUrl: property.base_url, apiKey: decrypt(property.api_key_enc), ...opts });
}

function publicView(p) {
  if (!p) return p;
  const {
    api_key_enc, webhook_secret_enc, webhook_token, raw, ...rest
  } = p;
  return rest;
}

module.exports = { listEnabled, getById, resolve, clientFor, publicView, UUID_RE };
