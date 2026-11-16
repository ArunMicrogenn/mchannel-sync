'use strict';
// One JSON line per log entry (PM2 keeps them in ~/.pm2/logs).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;

function setLevel(level) {
  threshold = LEVELS[level] || LEVELS.info;
}

function write(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const entry = { t: new Date().toISOString(), level, msg };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      entry[k] = v instanceof Error ? v.message : v;
    }
  }
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

module.exports = {
  setLevel,
  debug: (m, f) => write('debug', m, f),
  info: (m, f) => write('info', m, f),
  warn: (m, f) => write('warn', m, f),
  error: (m, f) => write('error', m, f),
};
