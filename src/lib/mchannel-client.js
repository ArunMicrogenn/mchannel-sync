'use strict';
// HTTP client for the M-Channel PMS Integration API (contract mchannel-v1).
//  - X-MChannel-Key on every call except the pairing claim
//  - contract_version added to every request body
//  - retries network errors, 429 (waits retry_after_seconds), 500, 502, 503, 504
//  - never retries 400, 401, 403, 404, 409, 422 (spec 3.5)

const crypto = require('crypto');
const config = require('../config');
const log = require('./logger');

const RETRYABLE = new Set([0, 408, 429, 500, 502, 503, 504]);

class MChannelError extends Error {
  constructor({ status, code, message, details, requestId, retryAfter, body }) {
    super(message || code || `HTTP ${status}`);
    this.name = 'MChannelError';
    this.status = status;
    this.code = code || (status === 0 ? 'network_error' : `http_${status}`);
    this.details = details;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
    this.body = body;
    this.retryable = RETRYABLE.has(status);
  }

  summary() {
    const parts = [`${this.status} ${this.code}`];
    if (this.message && this.message !== this.code) parts.push(this.message);
    if (this.details) parts.push(JSON.stringify(this.details));
    if (this.requestId) parts.push(`request_id=${this.requestId}`);
    return parts.join(' | ').slice(0, 1000);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class MChannelClient {
  constructor({ baseUrl, apiKey, timeoutMs, maxAttempts } = {}) {
    if (!baseUrl) throw new Error('baseUrl is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs || config.httpTimeoutMs;
    this.maxAttempts = maxAttempts || 3;
  }

  async request(method, path, { body, query, auth = true, attempts } = {}) {
    const maxAttempts = attempts || this.maxAttempts;
    let url = this.baseUrl + path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }

    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const requestId = crypto.randomUUID();
      const headers = { Accept: 'application/json', 'X-Request-Id': requestId };
      if (auth) {
        if (!this.apiKey) throw new Error('API key missing for authenticated call');
        headers['X-MChannel-Key'] = this.apiKey;
      }
      let payload;
      if (body !== undefined && body !== null) {
        payload = JSON.stringify({ contract_version: config.contractVersion, ...body });
        headers['Content-Type'] = 'application/json';
      }

      let res;
      let text = '';
      try {
        res = await fetch(url, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        text = await res.text();
      } catch (err) {
        lastErr = new MChannelError({ status: 0, message: err.message, requestId });
        log.warn('mchannel network error', { method, path, attempt, err: err.message, request_id: requestId });
        if (attempt < maxAttempts) {
          await sleep(backoff(attempt));
          continue;
        }
        throw lastErr;
      }

      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch (_) {
          json = null;
        }
      }

      if (res.status >= 200 && res.status < 300) {
        return { status: res.status, body: json, data: json ? json.data : undefined, requestId };
      }

      const e = (json && json.error) || {};
      lastErr = new MChannelError({
        status: res.status,
        code: e.code,
        message: e.message || (text ? text.slice(0, 300) : undefined),
        details: e.details,
        requestId: e.request_id || requestId,
        retryAfter: e.retry_after_seconds || numberHeader(res.headers.get('retry-after')),
        body: json,
      });
      log.warn('mchannel error response', {
        method, path, attempt, status: res.status, code: lastErr.code, request_id: lastErr.requestId,
      });
      if (!lastErr.retryable || attempt >= maxAttempts) throw lastErr;
      const wait = lastErr.retryAfter ? Math.min(lastErr.retryAfter, 120) * 1000 : backoff(attempt);
      await sleep(wait);
    }
    throw lastErr;
  }

  get(path, query, opts) {
    return this.request('GET', path, { ...opts, query });
  }

  post(path, body, opts) {
    return this.request('POST', path, { ...opts, body: body || {} });
  }

  put(path, body, opts) {
    return this.request('PUT', path, { ...opts, body: body || {} });
  }

  // ---- Endpoints (spec section 12) -------------------------------------
  claimPairing(body) {
    // No API key: the code is the credential. 10 claims/min/IP, so no retries.
    return this.request('POST', '/api/v1/pairing/claim', { body, auth: false, attempts: 1 });
  }
  pairingStatus(propertyId) {
    return this.get('/api/v1/pairing/status', { property_id: propertyId });
  }
  listProperties() {
    return this.get('/api/v1/properties');
  }
  roomTypes(pid) {
    return this.get(`/api/v1/properties/${pid}/room-types`);
  }
  ratePlans(pid) {
    return this.get(`/api/v1/properties/${pid}/rate-plans`);
  }
  putMappings(pid, mappings) {
    return this.put(`/api/v1/properties/${pid}/mappings`, { mappings });
  }
  pushAri(pid, body, opts) {
    return this.post(`/api/v1/properties/${pid}/ari`, body, opts);
  }
  readAri(pid, query) {
    return this.get(`/api/v1/properties/${pid}/ari`, query);
  }
  listStopSales(pid) {
    return this.get(`/api/v1/properties/${pid}/stop-sales`);
  }
  createStopSale(pid, body) {
    return this.post(`/api/v1/properties/${pid}/stop-sales`, body, { attempts: 1 });
  }
  reopenStopSale(pid, stopSaleId) {
    return this.post(`/api/v1/properties/${pid}/stop-sales/${stopSaleId}/reopen`, {});
  }
  pullBookings(pid, query) {
    return this.get(`/api/v1/properties/${pid}/bookings`, query);
  }
  ackBooking(bookingId, body, opts) {
    return this.post(`/api/v1/bookings/${bookingId}/ack`, body, opts);
  }
  reportNoShow(bookingId, waiveFees) {
    return this.post(`/api/v1/bookings/${bookingId}/no-show`, { waive_fees: !!waiveFees }, { attempts: 1 });
  }
  cancelRequest(bookingId, note) {
    return this.post(`/api/v1/bookings/${bookingId}/cancel-request`, { reason: 'invalid_card', note }, { attempts: 1 });
  }
  syncLog(pid, query) {
    return this.get(`/api/v1/properties/${pid}/sync-log`, query);
  }
  health(pid) {
    return this.get(`/api/v1/properties/${pid}/health`);
  }
}

function backoff(attempt) {
  return Math.min(30000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
}

function numberHeader(v) {
  const n = Number.parseInt(v || '', 10);
  return Number.isFinite(n) ? n : undefined;
}

module.exports = { MChannelClient, MChannelError, RETRYABLE };
