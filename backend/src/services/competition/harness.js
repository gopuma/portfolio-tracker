/**
 * Walk-forward backtest + live prediction + evaluation harness.
 *
 * Anti-leakage is structural: for an as-of index i, every model sees only
 * closes[0..i] (and sentiment dated <= dates[i]); the realized target is
 * closes[i + horizon] (trading days = array indices, since `prices` is one row per
 * trading day). Local (JS) models compute inline; remote (Python sidecar) models are
 * called in batch — Node sends the full series + the as-of indices, and the sidecar
 * trains a fresh model per index using only that index's past. Predictions are never
 * overwritten with different inputs for a past date.
 */
import { pool, query } from '../../db.js';
import { HORIZONS, getActiveModels } from '../prediction/registry.js';
import { forecastBatch, sidecarHealthy } from '../prediction/sidecar.js';
import {
  getUniverse, loadSeries, loadSentiment,
  upsertPrediction, upsertEvaluation, refreshLeaderboard,
} from './store.js';

const MIN_HISTORY = 60;

/** 7-day trailing sentiment average as of `asOfDate` (inclusive), point-in-time. */
function sentAvgAsOf(sentiment, asOfDate) {
  const end = new Date(`${asOfDate}T00:00:00`);
  const start = new Date(end); start.setDate(start.getDate() - 6);
  const sel = sentiment.filter(s => {
    const d = new Date(`${s.date}T00:00:00`);
    return d >= start && d <= end;
  });
  return sel.length ? sel.reduce((a, s) => a + s.score, 0) / sel.length : 0;
}

/**
 * Persist one forecast (and, if a realized price is given, its evaluation). Shared by
 * local and remote paths so the prediction/evaluation shape is identical everywhere.
 * `r` = { model_version, instrument_id, asOfDate, maturityDate, horizon, base,
 *         realized?, predicted_price, predicted_return, confidence, factors, pi_low?, pi_high? }
 */
async function storeForecast(conn, r) {
  const predId = await upsertPrediction({
    instrument_id: r.instrument_id, prediction_date: r.asOfDate, horizon_days: r.horizon,
    base_price: r.base, predicted_price: r.predicted_price, predicted_return: r.predicted_return,
    confidence: r.confidence, model_version: r.model_version,
    factors: { ...(r.factors || {}), pi_low: r.pi_low ?? null, pi_high: r.pi_high ?? null },
  }, conn);

  if (r.realized != null && r.realized > 0) {
    const realizedReturn = r.realized / r.base - 1;
    const err = r.predicted_return - realizedReturn;
    const dirPred = r.predicted_return >= 0 ? 1 : -1;   // flat forecast scored as "up"
    const dirReal = realizedReturn >= 0 ? 1 : -1;
    const inInterval = (r.pi_low != null && r.pi_high != null)
      ? (r.realized >= r.pi_low && r.realized <= r.pi_high) : null;
    await upsertEvaluation({
      prediction_id: predId, instrument_id: r.instrument_id, model_version: r.model_version,
      horizon_days: r.horizon, prediction_date: r.asOfDate, maturity_date: r.maturityDate,
      base_price: r.base, predicted_price: r.predicted_price, realized_price: r.realized,
      predicted_return: r.predicted_return, realized_return: realizedReturn,
      abs_error: Math.abs(err), sq_error: err * err,
      direction_hit: dirPred === dirReal, in_interval: inInterval,
    }, conn);
  }
}

async function writeRows(rows) {
  if (!rows.length) return;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const r of rows) await storeForecast(conn, r);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Backfill the last `window` matured trading days for every active model × instrument
 * × horizon, scoring each against the already-realized price. Local models compute
 * inline; remote (boosting) models are batch-forecast by the sidecar when it's up.
 * `mcPaths` lets the Monte-Carlo model use fewer paths during backfill.
 */
export async function backfill({ window = 180, mcPaths = 2000 } = {}) {
  const models = await getActiveModels();
  const local = models.filter(m => !m.remote);
  const remote = models.filter(m => m.remote);
  const sidecarUp = remote.length > 0 && await sidecarHealthy();
  if (remote.length && !sidecarUp) {
    console.warn('[competition] ML sidecar unreachable — skipping remote models:',
      remote.map(m => m.model_version).join(', '));
  }

  const universe = await getUniverse();
  let predictions = 0, skipped = 0;

  for (const inst of universe) {
    const { dates, closes } = await loadSeries(inst.id);
    if (closes.length < MIN_HISTORY) { skipped++; continue; }
    const sentiment = await loadSentiment(inst.id);
    const last = closes.length - 1;
    const rows = [];

    // Local models: walk each as-of index.
    for (const h of HORIZONS) {
      const startI = Math.max(0, last - h - window + 1);
      for (let i = startI; i + h <= last; i++) {
        const base = closes[i], realized = closes[i + h];
        if (!(base > 0) || !(realized > 0)) continue;
        const ctx = { closes: closes.slice(0, i + 1), sentAvg: sentAvgAsOf(sentiment, dates[i]) };
        for (const m of local) {
          if (i + 1 < m.min_history) continue;
          const cfg = m.model_version === 'montecarlo-v1' ? { ...m.config, paths: mcPaths } : m.config;
          let out;
          try { out = m.predict(ctx, h, cfg); } catch { continue; }
          if (!out || !(out.predicted_price > 0)) continue;
          rows.push({
            model_version: m.model_version, instrument_id: inst.id,
            asOfDate: dates[i], maturityDate: dates[i + h], horizon: h, base, realized,
            predicted_price: out.predicted_price, predicted_return: out.predicted_return,
            confidence: out.confidence, factors: out.factors, pi_low: out.pi_low, pi_high: out.pi_high,
          });
        }
      }
    }

    // Remote models: one batched sidecar call per (horizon × model).
    if (sidecarUp) {
      for (const h of HORIZONS) {
        const startI = Math.max(0, last - h - window + 1);
        for (const m of remote) {
          const asOf = [];
          for (let i = startI; i + h <= last; i++) if (i + 1 >= m.min_history) asOf.push(i);
          if (!asOf.length) continue;
          let preds;
          try {
            preds = await forecastBatch({ sidecarModel: m.sidecarModel, horizon: h, config: m.config, closes, asOf });
          } catch (e) {
            console.error(`[competition] sidecar ${m.model_version} ${inst.symbol} h=${h}:`, e.message);
            continue;
          }
          for (const p of preds) {
            const i = p.as_of;
            const base = closes[i], realized = closes[i + h];
            if (!(base > 0) || !(realized > 0) || !(p.predicted_price > 0)) continue;
            rows.push({
              model_version: m.model_version, instrument_id: inst.id,
              asOfDate: dates[i], maturityDate: dates[i + h], horizon: h, base, realized,
              predicted_price: p.predicted_price, predicted_return: p.predicted_return,
              confidence: p.confidence, factors: p.factors, pi_low: p.pi_low, pi_high: p.pi_high,
            });
          }
        }
      }
    }

    try { await writeRows(rows); predictions += rows.length; }
    catch (e) { console.error(`[competition] backfill ${inst.symbol} write failed:`, e.message); }
  }

  const lb = await refreshLeaderboard(window);
  return { predictions, skipped, instruments: universe.length, sidecar: sidecarUp, ...lb };
}

/**
 * Make today's forecasts: every active model × instrument × horizon, as of the most
 * recent close. These mature later and are scored by runEvaluation().
 */
export async function runDailyPredictions() {
  const models = await getActiveModels();
  const local = models.filter(m => !m.remote);
  const remote = models.filter(m => m.remote);
  const sidecarUp = remote.length > 0 && await sidecarHealthy();

  const universe = await getUniverse();
  let predictions = 0;

  for (const inst of universe) {
    const { dates, closes } = await loadSeries(inst.id);
    if (closes.length < MIN_HISTORY) continue;
    const sentiment = await loadSentiment(inst.id);
    const i = closes.length - 1;
    const base = closes[i];
    const ctx = { closes, sentAvg: sentAvgAsOf(sentiment, dates[i]) };
    const rows = [];

    for (const h of HORIZONS) {
      for (const m of local) {
        if (i + 1 < m.min_history) continue;
        let out;
        try { out = m.predict(ctx, h, m.config); } catch { continue; }
        if (!out || !(out.predicted_price > 0)) continue;
        rows.push({
          model_version: m.model_version, instrument_id: inst.id,
          asOfDate: dates[i], horizon: h, base,
          predicted_price: out.predicted_price, predicted_return: out.predicted_return,
          confidence: out.confidence, factors: out.factors, pi_low: out.pi_low, pi_high: out.pi_high,
        });
      }
      if (sidecarUp) {
        for (const m of remote) {
          if (i + 1 < m.min_history) continue;
          let preds;
          try { preds = await forecastBatch({ sidecarModel: m.sidecarModel, horizon: h, config: m.config, closes, asOf: [i] }); }
          catch { continue; }
          for (const p of preds) {
            if (!(p.predicted_price > 0)) continue;
            rows.push({
              model_version: m.model_version, instrument_id: inst.id,
              asOfDate: dates[i], horizon: h, base,
              predicted_price: p.predicted_price, predicted_return: p.predicted_return,
              confidence: p.confidence, factors: p.factors, pi_low: p.pi_low, pi_high: p.pi_high,
            });
          }
        }
      }
    }
    try { await writeRows(rows); predictions += rows.length; }
    catch (e) { console.error(`[competition] daily ${inst.symbol} write failed:`, e.message); }
  }
  return { predictions, instruments: universe.length, sidecar: sidecarUp };
}

/**
 * Score predictions whose maturity has arrived (the close `horizon` trading days
 * after prediction_date now exists) and that aren't yet evaluated. Then refresh
 * the leaderboard. Model-agnostic — works for local and remote alike.
 */
export async function runEvaluation({ window = 180 } = {}) {
  const pending = await query(
    `SELECT p.id, p.instrument_id, p.model_version, p.horizon_days, p.prediction_date,
            p.base_price, p.predicted_price, p.predicted_return, p.factors_json
       FROM predictions p
       LEFT JOIN prediction_evaluations e ON e.prediction_id = p.id
      WHERE e.id IS NULL`
  );
  let scored = 0;
  const seriesCache = new Map();

  for (const p of pending) {
    if (!seriesCache.has(p.instrument_id)) {
      seriesCache.set(p.instrument_id, await loadSeries(p.instrument_id));
    }
    const { dates, closes } = seriesCache.get(p.instrument_id);
    const predDate = (p.prediction_date instanceof Date ? p.prediction_date.toISOString() : String(p.prediction_date)).slice(0, 10);
    const idx = dates.indexOf(predDate);
    if (idx < 0) continue;
    const matIdx = idx + p.horizon_days;
    if (matIdx > closes.length - 1) continue;     // not matured yet

    const base = Number(p.base_price);
    const realized = closes[matIdx];
    const factors = typeof p.factors_json === 'string' ? JSON.parse(p.factors_json) : (p.factors_json || {});
    const realizedReturn = realized / base - 1;
    const predictedReturn = Number(p.predicted_return);
    const err = predictedReturn - realizedReturn;
    const dirPred = predictedReturn >= 0 ? 1 : -1;
    const dirReal = realizedReturn >= 0 ? 1 : -1;
    const piLow = factors.pi_low ?? null, piHigh = factors.pi_high ?? null;
    const inInterval = (piLow != null && piHigh != null) ? (realized >= piLow && realized <= piHigh) : null;

    await upsertEvaluation({
      prediction_id: p.id, instrument_id: p.instrument_id, model_version: p.model_version,
      horizon_days: p.horizon_days, prediction_date: predDate, maturity_date: dates[matIdx],
      base_price: base, predicted_price: Number(p.predicted_price), realized_price: realized,
      predicted_return: predictedReturn, realized_return: realizedReturn,
      abs_error: Math.abs(err), sq_error: err * err,
      direction_hit: dirPred === dirReal, in_interval: inInterval,
    });
    scored++;
  }

  const lb = await refreshLeaderboard(window);
  return { scored, ...lb };
}

export { refreshLeaderboard };
