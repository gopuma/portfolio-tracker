/**
 * Client for the Python ML sidecar (FastAPI + XGBoost/LightGBM).
 *
 * The sidecar is stateless: we hand it a point-in-time close series, a horizon, and
 * the as-of indices to forecast; it returns one prediction per index, each trained
 * only on data at-or-before that index. If the sidecar is unreachable, the backend
 * simply skips the boosting models — the rest of the competition keeps working.
 */
const BASE = process.env.ML_SIDECAR_URL || 'http://localhost:8008';

/** Is the sidecar up? Used to decide whether to attempt the boosting models. */
export async function sidecarHealthy() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Forecast at each as-of index. Returns an array of prediction objects
 * { as_of, predicted_return, predicted_price, confidence, factors }.
 * `sidecarModel` is the Python-side key ('xgboost' | 'lightgbm').
 */
export async function forecastBatch({ sidecarModel, horizon, config, closes, asOf }) {
  if (!asOf.length) return [];
  const res = await fetch(`${BASE}/forecast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: sidecarModel, horizon, config: config || {}, closes, as_of: asOf }),
    // Backfill can train many models in one call — allow a generous timeout.
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`sidecar ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.predictions || [];
}
