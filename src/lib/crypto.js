'use strict';
// AES-256-GCM for the API key and webhook secret (the spec asks for both to be
// stored encrypted), plus helpers for tokens and webhook signatures.

const crypto = require('crypto');
const config = require('../config');

function masterKey() {
  const raw = config.encryptionKey;
  if (!raw) throw new Error('ENCRYPTION_KEY is not set');
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, 'hex');
  else key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)');
  return key;
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

function decrypt(blob) {
  const [v, iv, tag, ct] = String(blob).split(':');
  if (v !== 'v1') throw new Error('unknown ciphertext version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// HMAC-SHA256(secret, timestamp + "." + raw body), lowercase hex (spec 7.1)
function webhookSignature(secret, timestamp, rawBody) {
  return crypto
    .createHmac('sha256', secret)
    .update(String(timestamp) + '.')
    .update(rawBody)
    .digest('hex');
}

module.exports = { encrypt, decrypt, randomToken, sha256, safeEqual, webhookSignature };
