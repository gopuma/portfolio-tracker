import express from 'express';
import { query } from '../db.js';
import { ensureTrackedInstrument } from '../services/instrumentService.js';
import { fetchStatements, fetchEstimates } from '../services/fundamentalsService.js';
import { computeRatios } from '../services/fundamentalRatios.js';
import { buildConverter } from '../services/fxService.js';

export const researchRouter = express.Router();

// Cache TTLs: statements are stable (quarterly), estimates get revised often.
const STMT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const EST_TTL_MS = 24 * 60 * 60 * 1000;      // 1 day

// Monetary statement columns that get FX-converted (per-share EPS too; shares don't).
const MONEY_COLS = [
  'revenue', 'cost_of_revenue', 'gross_profit', 'operating_income', 'net_income',
  'total_assets', 'total_liabilities', 'total_equity', 'cash_sti', 'total_debt',
  'operating_cf', 'capex', 'fcf',
];
const STMT_COLS = [...MONEY_COLS, 'eps_diluted', 'shares'];

const ML_SIDECAR_URL = process.env.ML_SIDECAR_URL || 'http://127.0.0.1:8008';

// In-memory cache for the estimates/valuation payload (one quoteSummary call), 1-day TTL.
const estCache = new Map(); // symbol -> { at, data }

// Next-quarter model estimate from the ML sidecar (seasonal-naive on the native quarterly
// series), as a supplement to consensus. Returns a display-currency estimate for '0q', or
// [] if the sidecar is unavailable. Persists the native forecast for later accuracy tracking.
async function fetchModelEstimate(instrumentId, quarterlyNative, shares, currency, conv, curPeriod) {
  const revenue = quarterlyNative.map(r => (r.revenue == null ? null : Number(r.revenue)));
  const eps = quarterlyNative.map(r => (r.eps_diluted == null ? null : Number(r.eps_diluted)));
  if (revenue.filter(x => x != null).length < 2) return [];
  try {
    const resp = await fetch(`${ML_SIDECAR_URL}/fundamentals/forecast`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revenue, eps }), signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return [];
    const m = await resp.json();
    if (m.revenue == null && m.eps == null) return [];
    query(
      `INSERT INTO estimates (instrument_id, period_label, currency, revenue_avg, eps_avg, source)
       VALUES (?, '0q', ?, ?, ?, 'model')
       ON DUPLICATE KEY UPDATE currency=VALUES(currency), revenue_avg=VALUES(revenue_avg), eps_avg=VALUES(eps_avg), as_of=CURRENT_TIMESTAMP`,
      [instrumentId, currency, m.revenue, m.eps]
    ).catch(() => {});
    const revenue2 = conv.convert(m.revenue, curPeriod);
    const eps2 = conv.convert(m.eps, curPeriod);
    const net = eps2 != null && shares != null ? eps2 * shares : null;
    return [{
      period_label: '0q', source: 'model', revenue: revenue2, eps: eps2, net_income: net,
      net_margin: revenue2 ? (net == null ? null : net / revenue2) : null,
    }];
  } catch { return []; }
}

// Period start for a period-average FX window: fiscal_date is the period END.
function periodStart(fiscalDate, freq) {
  const d = new Date(`${fiscalDate}T00:00:00`);
  d.setMonth(d.getMonth() - (freq === 'annual' ? 12 : 3));
  return d.toISOString().slice(0, 10);
}

async function loadStoredStatements(instrumentId, freq) {
  return query(
    `SELECT DATE_FORMAT(fiscal_date,'%Y-%m-%d') AS fiscal_date, currency,
            ${STMT_COLS.join(', ')}, UNIX_TIMESTAMP(fetched_at) AS fetched_ts
       FROM fundamentals WHERE instrument_id = ? AND freq = ? ORDER BY fiscal_date ASC`,
    [instrumentId, freq]
  );
}

async function upsertStatements(instrumentId, freq, rows, currency) {
  for (const r of rows) {
    const vals = STMT_COLS.map(c => (r[c] == null ? null : r[c]));
    await query(
      `INSERT INTO fundamentals (instrument_id, freq, fiscal_date, currency, ${STMT_COLS.join(', ')})
       VALUES (?, ?, ?, ?, ${STMT_COLS.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE currency=VALUES(currency), ${STMT_COLS.map(c => `${c}=VALUES(${c})`).join(', ')}, fetched_at=CURRENT_TIMESTAMP`,
      [instrumentId, freq, r.fiscal_date, currency, ...vals]
    );
  }
}

// Consensus estimates are persisted so the ML model (step 4) can compare against them.
async function upsertConsensus(instrumentId, currency, consensus) {
  for (const c of consensus) {
    await query(
      `INSERT INTO estimates (instrument_id, period_label, period_end, currency, revenue_avg, eps_avg, num_analysts, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'consensus')
       ON DUPLICATE KEY UPDATE period_end=VALUES(period_end), currency=VALUES(currency),
         revenue_avg=VALUES(revenue_avg), eps_avg=VALUES(eps_avg), num_analysts=VALUES(num_analysts), as_of=CURRENT_TIMESTAMP`,
      [instrumentId, c.period_label, c.period_end, currency, c.revenue_avg, c.eps_avg, c.num_analysts]
    );
  }
}

// Estimates + valuation + snapshot, via the in-memory 1-day cache.
async function getEstimates(symbol, instrumentId) {
  const hit = estCache.get(symbol);
  if (hit && Date.now() - hit.at < EST_TTL_MS) return hit.data;
  const data = await fetchEstimates(symbol);
  estCache.set(symbol, { at: Date.now(), data });
  if (data.consensus?.length) {
    upsertConsensus(instrumentId, data.currency, data.consensus).catch(() => {});
  }
  return data;
}

/**
 * Statements for a symbol, served from the DB cache and refreshed past the TTL.
 * Shared by the research page and the ratios endpoint so both see identical inputs.
 */
async function getStatements(symbol, instrumentId, nativeCcy) {
  let quarterly = await loadStoredStatements(instrumentId, 'quarterly');
  let annual = await loadStoredStatements(instrumentId, 'annual');
  const now = Date.now() / 1000;
  const fresh = rows => rows.length > 0 && rows.every(r => now - Number(r.fetched_ts) < STMT_TTL_MS / 1000);

  if (!fresh(quarterly) || !fresh(annual)) {
    const st = await fetchStatements(symbol);
    if (st.quarterly.length) await upsertStatements(instrumentId, 'quarterly', st.quarterly, nativeCcy);
    if (st.annual.length) await upsertStatements(instrumentId, 'annual', st.annual, nativeCcy);
    quarterly = await loadStoredStatements(instrumentId, 'quarterly');
    annual = await loadStoredStatements(instrumentId, 'annual');
  }
  return { quarterly, annual };
}

/**
 * Uniform fundamental ratios (PER/PBR/EPS/ROE/…) for one symbol — the stock page's
 * fundamentals panel. Deliberately lighter than the full research payload below: no ML
 * sidecar call, no FX conversion, since ratios are computed in native currency.
 *
 * Priced off the latest stored close so the multiples match the rest of the app; the
 * price and its date are returned so the UI can state what the ratio is "as of".
 */
researchRouter.get('/:symbol/ratios', async (req, res, next) => {
  try {
    let inst;
    try {
      inst = (await ensureTrackedInstrument(req.params.symbol)).instrument;
    } catch (e) {
      return res.status(e.status || 502).json({ error: e.message });
    }

    // Estimates give us the reporting currency and a shares fallback; a failure here
    // only costs the fallback, so ratios still compute from statements alone.
    const estimates = await getEstimates(req.params.symbol, inst.id).catch(() => null);
    const { quarterly } = await getStatements(req.params.symbol, inst.id, estimates?.currency || inst.currency);
    const nativeCcy = estimates?.currency || quarterly[0]?.currency || inst.currency || null;

    const [px] = await query(
      `SELECT close_px, DATE_FORMAT(trade_date,'%Y-%m-%d') AS trade_date
         FROM prices WHERE instrument_id = ? ORDER BY trade_date DESC LIMIT 1`,
      [inst.id]
    );

    const ratios = computeRatios(quarterly, {
      price: px ? Number(px.close_px) : null,
      currency: nativeCcy,
      sharesOutstanding: estimates?.shares ?? null,
    });

    res.json({
      symbol: inst.symbol,
      display_name: inst.display_name,
      asset_class: inst.asset_class,
      price_date: px?.trade_date || null,
      ...ratios,
    });
  } catch (e) { next(e); }
});

/**
 * Single-stock fundamentals research. Any searchable ticker works (auto-tracked).
 * Query: ?currency=native|USD|KRW (period-average FX conversion of absolute figures).
 */
researchRouter.get('/:symbol', async (req, res, next) => {
  try {
    let inst;
    try {
      inst = (await ensureTrackedInstrument(req.params.symbol)).instrument;
    } catch (e) {
      return res.status(e.status || 502).json({ error: e.message });
    }

    const target = String(req.query.currency || 'native').toUpperCase();

    // Statements — DB cache with a 7-day TTL.
    let estimates = await getEstimates(req.params.symbol, inst.id).catch(() => null);
    const preCcy = estimates?.currency || inst.currency || null;
    const { quarterly, annual } = await getStatements(req.params.symbol, inst.id, preCcy);
    const nativeCcy = estimates?.currency || quarterly[0]?.currency || annual[0]?.currency || inst.currency || null;

    // FX converter (period-average). Unsupported native currency → pass-through + flag.
    const conv = await buildConverter(nativeCcy, target);
    const displayCcy = (target === 'NATIVE' || !conv.supported) ? nativeCcy : target;

    const convertRows = (rows, freq) => rows.map(r => {
      const period = { start: periodStart(r.fiscal_date, freq), end: r.fiscal_date };
      const out = { fiscal_date: r.fiscal_date };
      for (const c of MONEY_COLS) out[c] = conv.convert(r[c] == null ? null : Number(r[c]), period);
      out.eps_diluted = conv.convert(r.eps_diluted == null ? null : Number(r.eps_diluted), period);
      out.shares = r.shares == null ? null : Number(r.shares);
      return out;
    });

    // Forward estimates: convert at the CURRENT rate (~last 30d window). Derive net income
    // (EPS × shares) and net margin from consensus.
    const today = new Date().toISOString().slice(0, 10);
    const curStart = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const curPeriod = { start: curStart, end: today };
    const shares = estimates?.shares || null;
    const consensus = (estimates?.consensus || []).map(c => {
      const revenue = conv.convert(c.revenue_avg, curPeriod);
      const eps = conv.convert(c.eps_avg, curPeriod);
      const net_income = eps != null && shares != null ? eps * shares : null;
      return {
        period_label: c.period_label, period_end: c.period_end, num_analysts: c.num_analysts,
        revenue, eps, net_income, net_margin: revenue ? (net_income == null ? null : net_income / revenue) : null,
      };
    });

    res.json({
      symbol: inst.symbol,
      display_name: inst.display_name,
      reporting_currency: nativeCcy,
      display_currency: displayCcy,
      fx_supported: conv.supported,
      valuation: estimates?.valuation || null,
      snapshot: estimates?.snapshot ? {
        ...estimates.snapshot,
        market_cap: conv.convert(estimates.valuation?.market_cap ?? null, curPeriod),
        target_mean_price: conv.convert(estimates.snapshot.target_mean_price, curPeriod),
      } : null,
      statements: { quarterly: convertRows(quarterly, 'quarterly'), annual: convertRows(annual, 'annual') },
      estimates: {
        consensus,
        model: await fetchModelEstimate(inst.id, quarterly, shares, nativeCcy, conv, curPeriod),
      },
    });
  } catch (e) { next(e); }
});
