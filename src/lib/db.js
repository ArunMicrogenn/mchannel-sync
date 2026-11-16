'use strict';
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const config = require('../config');
const log = require('./logger');

// Keep DATE columns as 'YYYY-MM-DD' strings (hotel local dates, no time zone
// shifting). NUMERIC already comes back as a string, which is what we want
// for money.
types.setTypeParser(1082, (v) => v);

if (!/^[a-z_][a-z0-9_]*$/.test(config.dbSchema)) {
  throw new Error('DB_SCHEMA must be a plain lowercase identifier');
}

let pool;

function getPool() {
  if (!pool) {
    if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      options: `-c search_path=${config.dbSchema},public -c timezone=UTC`,
    });
    pool.on('error', (err) => log.error('postgres pool error', { err }));
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

async function migrate() {
  const dir = path.join(__dirname, '..', '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const client = await getPool().connect();
  const applied = [];
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${config.dbSchema}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${config.dbSchema}.schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    // Serialize concurrent migrators.
    await client.query('SELECT pg_advisory_lock(727001)');
    const done = new Set(
      (await client.query(`SELECT name FROM ${config.dbSchema}.schema_migrations`)).rows.map((r) => r.name),
    );
    for (const f of files) {
      if (done.has(f)) continue;
      let sql = fs.readFileSync(path.join(dir, f), 'utf8');
      if (config.dbSchema !== 'mchannel') sql = sql.replace(/\bmchannel\./g, `${config.dbSchema}.`)
        .replace(/SCHEMA IF NOT EXISTS mchannel/g, `SCHEMA IF NOT EXISTS ${config.dbSchema}`)
        .replace(/search_path = mchannel/g, `search_path = ${config.dbSchema}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO ${config.dbSchema}.schema_migrations(name) VALUES ($1)`, [f]);
        await client.query('COMMIT');
        applied.push(f);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${err.message}`);
      }
    }
    await client.query(`SET search_path = ${config.dbSchema}, public`);
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
  return applied;
}

async function close() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = { query, tx, migrate, close, getPool };
