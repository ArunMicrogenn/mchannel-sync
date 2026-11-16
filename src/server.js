'use strict';
// mchannel-sync: background sync between M-Channel and PostgreSQL.
//   - fetches bookings (pull every BOOKING_PULL_MINUTES, plus the webhook
//     M-Channel requires at pairing), stores them and acks them
//   - pushes room inventory, rates and restrictions written to Postgres
// HTTP (127.0.0.1:3200, behind nginx): only POST /mchannel/webhook/:token and
// GET /health (local check).

const express = require('express');
const config = require('./config');
const db = require('./lib/db');
const log = require('./lib/logger');
const { Scheduler } = require('./scheduler');
const { createWebhookRouter } = require('./routes/webhook');

log.setLevel(config.logLevel);

function createApp(scheduler) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(createWebhookRouter({ onBookingSaved: () => scheduler && scheduler.kickAcks() }));
  app.get('/health', async (req, res) => {
    let ok = false;
    try {
      await db.query('SELECT 1');
      ok = true;
    } catch (_) {
      ok = false;
    }
    res.status(ok ? 200 : 503).json({ ok, service: 'mchannel-sync', version: config.version, db: ok });
  });
  app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Not found' } }));
  return app;
}

async function main() {
  const problems = [];
  if (!config.databaseUrl) problems.push('DATABASE_URL is not set');
  if (!config.encryptionKey) problems.push('ENCRYPTION_KEY is not set');
  if (problems.length) {
    for (const p of problems) log.error(p, { env_file: config.envFile });
    process.exit(1);
  }
  if (!config.publicBaseUrl.startsWith('https://')) log.warn('PUBLIC_BASE_URL is not an https:// address; pairing will refuse to run');

  const applied = await db.migrate();
  if (applied.length) log.info('migrations applied', { applied });

  const scheduler = new Scheduler();
  const app = createApp(scheduler);
  const server = app.listen(config.port, config.host, () => {
    log.info('mchannel-sync running', {
      host: config.host, port: config.port, version: config.version, ack_mode: config.ackMode,
      booking_pull_minutes: config.bookingPullMinutes, push_interval_seconds: config.pushIntervalSeconds,
    });
  });
  server.requestTimeout = 30000;
  await scheduler.start();

  const shutdown = (sig) => {
    log.info('shutting down', { sig });
    scheduler.stop();
    server.close(() => db.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => {
    log.error('startup failed', { err });
    process.exit(1);
  });
}

module.exports = { createApp };
