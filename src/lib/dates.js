'use strict';
// Hotel-local calendar dates as 'YYYY-MM-DD' strings.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function todayIn(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch (_) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }
}

function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000);
}

// UTC timestamp in the spec's format: ISO 8601 ending in Z, no milliseconds.
function utcStamp(d) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

module.exports = { isDate, todayIn, addDays, daysBetween, utcStamp };
