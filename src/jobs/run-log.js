'use strict';
const db = require('../lib/db');
const log = require('../lib/logger');

// Records a job run in sync_runs and logs the outcome.
async function withRunLog(propertyId, job, fn) {
  const { rows } = await db.query(
    'INSERT INTO sync_runs(property_id, job) VALUES ($1, $2) RETURNING id',
    [propertyId, job],
  );
  const runId = rows[0].id;
  const started = Date.now();
  try {
    const result = (await fn()) || {};
    await db.query(
      'UPDATE sync_runs SET finished_at = now(), ok = true, items = $2, detail = $3 WHERE id = $1',
      [runId, result.items ?? null, result.detail ?? null],
    );
    log.info('job ok', { job, property_id: propertyId, ms: Date.now() - started, ...result });
    return result;
  } catch (err) {
    const detail = typeof err.summary === 'function' ? err.summary() : err.message;
    await db
      .query('UPDATE sync_runs SET finished_at = now(), ok = false, detail = $2 WHERE id = $1', [runId, detail])
      .catch(() => {});
    log.error('job failed', { job, property_id: propertyId, ms: Date.now() - started, err: detail });
    throw err;
  }
}

module.exports = { withRunLog };
