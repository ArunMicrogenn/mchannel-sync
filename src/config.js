'use strict';
// Configuration. Values come from the process environment; on the VPS they are
// loaded from /etc/mchannel-sync/mchannel-sync.env (override the path with
// MCHANNEL_SYNC_ENV). Variables already set in the environment win.

const fs = require('fs');

const ENV_FILE = process.env.MCHANNEL_SYNC_ENV || '/etc/mchannel-sync/mchannel-sync.env';

function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return false;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}

const envFileLoaded = loadEnvFile(ENV_FILE);

function int(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  if (min !== undefined && n < min) throw new Error(`${name} must be >= ${min}`);
  if (max !== undefined && n > max) throw new Error(`${name} must be <= ${max}`);
  return n;
}

function str(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

const config = {
  envFile: ENV_FILE,
  envFileLoaded,
  version: require('../package.json').version,

  host: str('HOST', '127.0.0.1'),
  port: int('PORT', 3200, 1, 65535),
  databaseUrl: str('DATABASE_URL', ''),
  dbSchema: str('DB_SCHEMA', 'mchannel'),

  // Public HTTPS address of this service; the webhook URL given at pairing is
  // <PUBLIC_BASE_URL>/mchannel/webhook/<token>
  publicBaseUrl: str('PUBLIC_BASE_URL', '').replace(/\/+$/, ''),

  encryptionKey: str('ENCRYPTION_KEY', ''),

  pmsName: str('PMS_NAME', 'Microgenn M-Channel Sync'),
  pmsVersion: str('PMS_VERSION', require('../package.json').version),

  baseUrls: {
    staging: str('MCHANNEL_STAGING_URL', 'https://stagcm.microgenn.com'),
    production: str('MCHANNEL_PRODUCTION_URL', 'https://cmlive.microgenn.com'),
  },
  contractVersion: '1.3.0',
  httpTimeoutMs: int('HTTP_TIMEOUT_MS', 30000, 1000),

  // Schedules
  bookingPullMinutes: int('BOOKING_PULL_MINUTES', 2, 1),
  bookingBackfillDays: int('BOOKING_BACKFILL_DAYS', 30, 1),
  bookingOverlapSeconds: int('BOOKING_OVERLAP_SECONDS', 300, 0),
  setupSyncHours: int('SETUP_SYNC_HOURS', 6, 1),
  ackIntervalSeconds: int('ACK_INTERVAL_SECONDS', 15, 1),
  pushIntervalSeconds: int('PUSH_INTERVAL_SECONDS', 15, 1),
  pushBatchMaxItems: int('PUSH_BATCH_MAX_ITEMS', 1000, 1, 10000),
  pushMaxRows: int('PUSH_MAX_ROWS', 20000, 100),

  // auto = ack every booking after it is committed to Postgres
  // hold = store it, and let the PMS ack it with SELECT mchannel.ack_booking(...)
  ackMode: str('ACK_MODE', 'auto'),

  webhookToleranceSeconds: int('WEBHOOK_TOLERANCE_SECONDS', 300, 30),
  retentionDays: int('RETENTION_DAYS', 90, 7),
  logLevel: str('LOG_LEVEL', 'info'),
  dataDir: str('DATA_DIR', '/var/lib/mchannel-sync'),
};

if (!['auto', 'hold'].includes(config.ackMode)) {
  throw new Error('ACK_MODE must be auto or hold');
}

module.exports = config;
