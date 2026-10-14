/**
 * Local-only request guards. The app has no login by design — it runs on one machine for
 * one user — so the protection is making sure a request really comes from that machine's
 * own frontend, and not from:
 *
 *  - another device on the network → the server binds to loopback only (see index.js);
 *  - a web page open in the user's browser (CSRF) → cross-site requests, foreign Origins,
 *    and state-changing requests without the app's custom header are refused;
 *  - DNS rebinding (an attacker's hostname re-pointed at 127.0.0.1, which sidesteps CORS
 *    because the browser then sees it as same-origin) → the Host header must name loopback.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Header the frontend sends on every state-changing request (see frontend/src/api.js). */
export const CLIENT_HEADER = 'X-Requested-With';
export const CLIENT_HEADER_VALUE = 'portfolio-tracker';

/**
 * Browser origins allowed to call the API: the Vite dev server by default. Override with a
 * comma-separated CORS_ORIGINS in .env if the frontend is served from somewhere else.
 */
export const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map(s => s.trim()).filter(Boolean)
);

// 'localhost:4000' -> 'localhost', '[::1]:4000' -> '[::1]'
function hostnameOf(hostHeader = '') {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

const forbid = (res, why) => res.status(403).json({ error: `Forbidden: ${why}` });

export function localRequestGuard(req, res, next) {
  // DNS rebinding: the page's hostname is the attacker's, even though it resolves to us.
  if (!LOOPBACK_HOSTNAMES.has(hostnameOf(req.headers.host))) {
    return forbid(res, 'the API only answers requests addressed to localhost');
  }
  // Browsers label every request with where it came from. Same-site (another localhost
  // port, e.g. the Vite dev server) and same-origin (through the Vite proxy) are fine.
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    return forbid(res, 'cross-site request');
  }
  // Browsers send Origin on cross-origin requests and on every POST/PATCH/DELETE; tools
  // like curl send none, and are allowed through (they can't be driven by a web page).
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return forbid(res, `origin ${origin} is not allowed`);
  }
  // A page can fire a plain form POST at us without asking; a custom header it cannot set
  // without a CORS preflight, which only the allowed origins pass.
  if (!SAFE_METHODS.has(req.method) && req.get(CLIENT_HEADER) !== CLIENT_HEADER_VALUE) {
    return forbid(res, `state-changing requests must send ${CLIENT_HEADER}: ${CLIENT_HEADER_VALUE}`);
  }
  next();
}

/** Response headers for a JSON-only API: nothing here should ever render, frame, or sniff. */
export function securityHeaders(_req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-site',
  });
  next();
}

/**
 * A URL that is safe to use as a link target: absolute http(s) only. Anything else — a
 * `javascript:` or `data:` URL from a poisoned feed, a relative path, garbage — yields ''.
 */
export function safeHttpUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return '';
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

/**
 * Run `fn` unless a job with the same key is already in flight, in which case answer 409.
 * Guards the slow, fan-out endpoints (full refresh, backtest) from being stacked.
 */
const inFlight = new Set();
export async function runExclusive(key, res, fn) {
  if (inFlight.has(key)) {
    return res.status(409).json({ error: 'That job is already running — wait for it to finish.' });
  }
  inFlight.add(key);
  try {
    return await fn();
  } finally {
    inFlight.delete(key);
  }
}
