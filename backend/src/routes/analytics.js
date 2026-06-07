import express from 'express';
import { query, getInstrument } from '../db.js';
import { TRADING_DAYS, riskStats, toReturns, pearsonMaps, betaAlpha } from '../services/stats.js';
import { optimizePortfolio } from '../services/mpt.js';

export const analyticsRouter = express.Router();

const DEFAULT_DAYS = 365;
const MAX_DAYS = 1825;

// Market benchmarks for CAPM alpha/beta, by instrument market.
const BENCHMARKS = { US: '^GSPC', KR: '^KS11' };
const BENCHMARK_NAMES = { '^GSPC': 'S&P 500', '^KS11': 'KOSPI' };

const clampDays = raw => Math.min(Number(raw || DEFAULT_DAYS), MAX_DAYS);

// Ordered { date, close } series for one instrument over a trailing window.
async function loadSeries(symbol, days) {
  const rows = await query(
    `SELECT p.trade_date, p.close_px
       FROM instruments i
       JOIN prices p ON p.instrument_id = i.id
      WHERE i.symbol = ?
        AND p.trade_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      ORDER BY p.trade_date ASC`,
    [symbol, days]
  );
  return rows.map(r => ({
    date: (r.trade_date instanceof Date ? r.trade_date.toISOString() : String(r.trade_date)).slice(0, 10),
    close: Number(r.close_px),
  }));
}

/**
 * Portfolio analytics: per-asset return/risk stats and a correlation matrix of
 * daily returns. See /services/stats.js for the formulas.
 * Query params: ?days=365 (capped 1825), ?rf=0 (annual risk-free rate, e.g. 0.04).
 */
analyticsRouter.get('/', async (req, res, next) => {
  try {
    const days = clampDays(req.query.days);
    const rf = Number(req.query.rf || 0);

    const rows = await query(
      `SELECT i.symbol, i.display_name, i.market, i.currency, p.trade_date, p.close_px
         FROM instruments i
         JOIN prices p ON p.instrument_id = i.id
        WHERE i.is_active = 1 AND i.watchlist = 1 AND i.market NOT IN ('FX', 'INDEX')
          AND p.trade_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        ORDER BY i.symbol ASC, p.trade_date ASC`,
      [days]
    );

    // Group by symbol -> ordered series.
    const bySymbol = new Map();
    for (const r of rows) {
      const s = bySymbol.get(r.symbol) || { meta: r, series: [] };
      s.series.push({ date: (r.trade_date instanceof Date ? r.trade_date.toISOString() : String(r.trade_date)).slice(0, 10), close: Number(r.close_px) });
      bySymbol.set(r.symbol, s);
    }

    const assets = [];
    const returnsBySymbol = new Map();
    for (const [symbol, { meta, series }] of bySymbol) {
      const stats = riskStats(series, rf);
      if (!stats) continue;
      returnsBySymbol.set(symbol, toReturns(series).map);
      assets.push({ symbol, display_name: meta.display_name, market: meta.market, currency: meta.currency, ...stats });
    }

    assets.sort((a, b) => (a.market === b.market ? a.symbol.localeCompare(b.symbol) : a.market.localeCompare(b.market)));
    const symbols = assets.map(a => a.symbol);
    const matrix = symbols.map((sa, i) =>
      symbols.map((sb, j) => (i === j ? 1 : pearsonMaps(returnsBySymbol.get(sa), returnsBySymbol.get(sb))))
    );

    res.json({
      days, rf, trading_days: TRADING_DAYS, count: assets.length,
      note: 'Daily simple returns, annualized with √252. Sharpe/Sortino use the arithmetic annualized mean; CAGR/total return are realized. Downside deviation & Sortino measure risk vs. the risk-free MAR only.',
      assets,
      correlation: { symbols, matrix },
    });
  } catch (e) { next(e); }
});

/**
 * MPT optimization over a set of symbols. Body: { symbols:[...], days?, rf? }
 * Returns the max-Sharpe (optimal), min-variance, and equal-weight portfolios.
 */
analyticsRouter.post('/optimize', async (req, res, next) => {
  try {
    const symbols = Array.isArray(req.body?.symbols) ? [...new Set(req.body.symbols.filter(Boolean))] : [];
    if (symbols.length < 2) return res.status(400).json({ error: 'Provide at least 2 symbols' });
    const days = clampDays(req.body?.days);
    const rf = Number(req.body?.rf || 0);

    const seriesBySymbol = new Map();
    for (const sym of symbols) {
      const series = await loadSeries(sym, days);
      if (series.length) seriesBySymbol.set(sym, series);
    }
    const result = optimizePortfolio(seriesBySymbol, { rf });
    if (result.error) return res.status(422).json({ days, rf, ...result });
    res.json({ days, ...result });
  } catch (e) { next(e); }
});

/**
 * Per-instrument return/risk stats plus CAPM alpha & beta vs the market benchmark
 * (S&P 500 for US, KOSPI for KR). Query params: ?days=365, ?rf=0.
 */
analyticsRouter.get('/:symbol', async (req, res, next) => {
  try {
    const inst = await getInstrument(req.params.symbol);
    if (!inst) return res.status(404).json({ error: 'Instrument not found' });
    const days = clampDays(req.query.days);
    const rf = Number(req.query.rf || 0);

    const series = await loadSeries(inst.symbol, days);
    const stats = riskStats(series, rf);
    if (!stats) {
      return res.json({ symbol: inst.symbol, days, rf, stats: null, note: 'Not enough price history for this window.' });
    }

    // Alpha/beta vs the market benchmark for this instrument's market.
    const benchSymbol = BENCHMARKS[inst.market] || null;
    let market = { benchmark: null, beta: null, alpha: null, correlation: null, r2: null, n: 0 };
    if (benchSymbol) {
      const benchSeries = await loadSeries(benchSymbol, days);
      const ba = betaAlpha(toReturns(series).map, toReturns(benchSeries).map, rf);
      market = { benchmark: benchSymbol, benchmark_name: BENCHMARK_NAMES[benchSymbol] || benchSymbol, ...ba };
    }

    res.json({
      symbol: inst.symbol,
      display_name: inst.display_name,
      market: inst.market,
      currency: inst.currency,
      days, rf, trading_days: TRADING_DAYS,
      stats,
      capm: market,
      note: 'Beta vs benchmark daily returns; alpha is annualized Jensen’s alpha. R² = share of the asset’s variance explained by the benchmark.',
    });
  } catch (e) { next(e); }
});
