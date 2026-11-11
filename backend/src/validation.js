/**
 * Request-input validation for ledger writes. Each parser returns the clean value or throws
 * an HttpError(400) with a message safe to show the user, so bad input never reaches MySQL
 * (where it would surface as a 500 carrying the raw driver error).
 *
 * Bounds follow the `transactions` columns: shares DECIMAL(26,8), price DECIMAL(18,4).
 * They are kept well inside the column limits so derived values (a rescaled buy price,
 * shares × price) can't overflow either.
 */

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true; // message is meant for the client (see the error handler)
  }
}

export const badRequest = message => new HttpError(400, message);

export const MAX_SHARES = 1e12;   // column allows < 1e18
export const MIN_SHARES = 0.00000001; // column scale is 8 (one satoshi)
export const MAX_PRICE = 1e10;    // column allows < 1e14
export const MIN_PRICE = 0.0001;  // column scale is 4 — anything smaller would store as 0
const MIN_DATE = '1970-01-01';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Local-time 'YYYY-MM-DD' (server timezone) — the same convention the routes date trades with.
export function todayLocal(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * A trade date: strict YYYY-MM-DD, a real calendar day, not in the future, not absurdly old.
 * Empty / missing → `fallback` (pass undefined to make the field required).
 */
export function parseTradeDate(raw, { fallback, today = todayLocal() } = {}) {
  if (raw == null || raw === '') {
    if (fallback !== undefined) return fallback;
    throw badRequest('trade_date is required (YYYY-MM-DD)');
  }
  const s = String(raw).trim();
  const m = ISO_DATE.exec(s);
  if (!m) throw badRequest('trade_date must be a date in YYYY-MM-DD format');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // Round-trip rejects impossible days such as 2026-02-30 or 2026-13-01.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw badRequest(`trade_date ${s} is not a real calendar date`);
  }
  if (s > today) throw badRequest(`trade_date ${s} is in the future`);
  if (s < MIN_DATE) throw badRequest(`trade_date must be on or after ${MIN_DATE}`);
  return s;
}

function parseBounded(raw, name, min, max, { allowZero = false } = {}) {
  // Reject booleans, arrays, objects: Number(true) === 1 and Number([5]) === 5 would slip through.
  if (typeof raw !== 'number' && typeof raw !== 'string') throw badRequest(`${name} must be a number`);
  if (typeof raw === 'string' && raw.trim() === '') throw badRequest(`${name} must be a number`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw badRequest(`${name} must be a number`);
  if (allowZero && n === 0) return 0;
  if (n < min) throw badRequest(allowZero ? `${name} must be zero or at least ${min}` : `${name} must be at least ${min}`);
  if (n > max) throw badRequest(`${name} must be at most ${max.toLocaleString('en-US')}`);
  return n;
}

/** Share count or cash amount: positive (or zero with allowZero), within column precision. */
export const parseShares = (raw, name = 'shares', opts) => parseBounded(raw, name, MIN_SHARES, MAX_SHARES, opts);

/** Per-share price or average cost: positive, within column precision. */
export const parsePrice = (raw, name = 'price') => parseBounded(raw, name, MIN_PRICE, MAX_PRICE);

/**
 * A numeric path id (portfolio, holding, transaction). Anything else is a 404 for `what`:
 * MySQL would otherwise coerce '12abc' to 12 and quietly act on the wrong row.
 */
export function parseId(raw, what) {
  const s = String(raw ?? '');
  if (!/^[1-9]\d{0,17}$/.test(s)) throw new HttpError(404, `${what} not found`);
  return Number(s);
}

/** True when an optional body field was supplied (not missing, null, or ''). */
export const provided = v => v !== undefined && v !== null && v !== '';

/** Account label: trimmed string, at most 64 chars (the column width). */
export function parseAccount(raw) {
  if (raw == null) return '';
  if (typeof raw !== 'string') throw badRequest('account must be a string');
  return raw.trim().slice(0, 64);
}
