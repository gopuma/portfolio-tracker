import express from 'express';
import { query } from '../db.js';
import { toReturns, regress } from '../services/stats.js';
import { loadSeries } from './analytics.js';
import { computePortfolio, loadHoldings, getFxRates } from './portfolios.js';

export const stressRouter = express.Router();

// Index history only goes back to late 2023, so the beta window tops out near 3 years.
const DEFAULT_DAYS = 730;
const MIN_DAYS = 180;
const MAX_DAYS = 1095;

// The index the market move is expressed against.
const US_INDEXES = { '^GSPC': 'S&P 500', '^IXIC': 'NASDAQ Composite' };

// Weekly returns need at least this many overlapping weeks for a beta.
const MIN_WEEKS = 26;

// Vasicek prior for equity betas: the cross-section of stock betas centres on 1 with a
// spread of about 0.5. Each estimate is pulled toward 1 in proportion to its own standard
// error, so a noisy beta (short history, wild stock) leans on the prior and a tight one
// (an index ETF, a T-bill fund) keeps its own value.
const PRIOR_BETA = 1;
const PRIOR_SD = 0.5;

const WEEKS_PER_YEAR = 52;

/**
 * Week key for a 'YYYY-MM-DD' trading date: the Friday that ends its week. Trading days
 * map forward to their own Friday, so every market lands on the same key for the same
 * calendar week whatever its holidays.
 */
function weekKey(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

// Last close of each week, as an ordered { date: weekKey, close } series.
function toWeekly(series) {
  const byWeek = new Map();
  for (const p of series) byWeek.set(weekKey(p.date), p.close);
  return [...byWeek.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, close]) => ({ date, close }));
}

// Date -> value lookup that carries the last known value forward over missing dates.
function forwardFilled(series) {
  const dates = series.map(p => p.date);
  const vals = series.map(p => p.close);
  return date => {
    let lo = 0, hi = dates.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] <= date) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return idx >= 0 ? vals[idx] : null;
  };
}

/**
 * Inputs for the market stress test, for every portfolio at once:
 *   - each portfolio's holdings valued in the display currency at today's prices and FX
 *   - each holding's sensitivity to the chosen US index, estimated the way commercial
 *     risk systems do it:
 *       · weekly returns over the trailing window (daily returns understate beta between
 *         markets that close at different hours, like Seoul and New York)
 *       · in the DISPLAY currency, so the exchange-rate move that tends to come with a
 *         market move is part of the beta, including for cash held in another currency
 *       · regressed directly on the shocked index, which is the conditional expectation a
 *         one-index shock calls for, for Korean listings as much as US ones
 *       · shrunk toward 1 by its standard error (Vasicek)
 *
 * The shock itself is applied in the browser, so the size and length of the move can
 * change without a round trip.
 *
 * Query params: ?days=730 (180–1095), ?us_index=^GSPC|^IXIC, ?currency=USD|KRW.
 */
stressRouter.get('/', async (req, res, next) => {
  try {
    const days = Math.min(Math.max(Math.round(Number(req.query.days)) || DEFAULT_DAYS, MIN_DAYS), MAX_DAYS);
    const usIndex = US_INDEXES[req.query.us_index] ? req.query.us_index : '^GSPC';
    const currency = req.query.currency === 'KRW' ? 'KRW' : 'USD';

    const fx = await getFxRates();
    const pfRows = await query(`SELECT id, name FROM portfolios ORDER BY id ASC`);
    const portfolios = [];
    const held = new Map(); // symbol -> native currency
    for (const p of pfRows) {
      const { holdings, totals } = computePortfolio(await loadHoldings(p.id), currency, fx);
      const priced = holdings.filter(h => h.market_value_base != null);
      for (const h of priced) held.set(h.symbol, h.currency);
      portfolios.push({
        id: p.id,
        name: p.name,
        total: totals.market_value,
        holdings: priced.map(h => ({
          symbol: h.symbol,
          display_name: h.display_name,
          is_cash: !!h.is_cash,
          currency: h.currency,
          value: h.market_value_base,
        })),
      });
    }

    // Daily FX for restating every price in the display currency.
    const [usdFx, jpyFx] = await Promise.all([loadSeries('KRW=X', days + 14), loadSeries('JPYKRW=X', days + 14)]);
    const krwPerUsd = forwardFilled(usdFx);
    const krwPerJpy = forwardFilled(jpyFx);
    // Multiplier taking one unit of `ccy` into the display currency on `date`, or null.
    const toDisplay = (ccy, date) => {
      if (ccy === currency) return 1;
      const toKrw = ccy === 'KRW' ? 1 : ccy === 'USD' ? krwPerUsd(date) : ccy === 'JPY' ? krwPerJpy(date) : null;
      if (toKrw == null) return null;
      const perDisplay = currency === 'KRW' ? 1 : krwPerUsd(date);
      return perDisplay ? toKrw / perDisplay : null;
    };
    const restate = (series, ccy) => {
      if (ccy === currency || !['USD', 'KRW', 'JPY'].includes(ccy)) return series; // other currencies stay local
      const out = [];
      for (const p of series) {
        const m = toDisplay(ccy, p.date);
        if (m != null) out.push({ date: p.date, close: p.close * m });
      }
      return out;
    };
    const weeklyReturns = series => toReturns(toWeekly(series)).map;

    const benchWeekly = weeklyReturns(await loadSeries(usIndex, days));

    // One holding's factor, raw and shrunk.
    const estimate = series => {
      const r = regress(weeklyReturns(series), benchWeekly, MIN_WEEKS);
      if (r.beta == null) {
        return { beta: PRIOR_BETA, beta_raw: null, beta_sd: PRIOR_SD, alpha: null, resid_sd: null, r2: null, n: r.n, assumed: true };
      }
      // Posterior of a normal prior and a normal estimate.
      const wData = 1 / (r.se_beta ** 2), wPrior = 1 / (PRIOR_SD ** 2);
      const beta = (wData * r.beta + wPrior * PRIOR_BETA) / (wData + wPrior);
      return {
        beta,
        beta_raw: r.beta,
        beta_sd: Math.sqrt(1 / (wData + wPrior)),
        alpha: r.alpha * WEEKS_PER_YEAR,
        resid_sd: r.resid_sd,
        r2: r.r2,
        n: r.n,
        assumed: false,
      };
    };

    const factors = {};
    for (const [symbol, ccy] of held) {
      if (symbol.startsWith('CASH:')) {
        if (ccy === currency) continue; // same-currency cash doesn't move
        // Foreign cash is a pure currency position: its "price" is the exchange rate.
        // No shrinkage — the beta-of-1 prior is about stocks, not currencies.
        const r = regress(weeklyReturns(restate(usdFx.map(p => ({ date: p.date, close: 1 })), ccy)), benchWeekly, MIN_WEEKS);
        factors[symbol] = r.beta == null
          ? { beta: 0, beta_raw: null, beta_sd: 0, alpha: null, resid_sd: null, r2: null, n: r.n, assumed: true }
          : { beta: r.beta, beta_raw: r.beta, beta_sd: r.se_beta, alpha: null, resid_sd: r.resid_sd, r2: r.r2, n: r.n, assumed: false };
        continue;
      }
      factors[symbol] = estimate(restate(await loadSeries(symbol, days), ccy));
    }

    // What the shock implies for KOSPI and the won, for the summary line. Raw betas.
    const kospi = regress(weeklyReturns(await loadSeries('^KS11', days)), benchWeekly, MIN_WEEKS);
    const won = regress(weeklyReturns(usdFx), benchWeekly, MIN_WEEKS);

    res.json({
      days, currency,
      frequency: 'weekly',
      prior: { beta: PRIOR_BETA, sd: PRIOR_SD },
      benchmark: { symbol: usIndex, name: US_INDEXES[usIndex] },
      us_indexes: Object.entries(US_INDEXES).map(([symbol, name]) => ({ symbol, name })),
      implied: {
        kospi: { beta: kospi.beta, r2: kospi.r2 },
        krw_per_usd: { beta: won.beta, r2: won.r2 },
      },
      factors,
      portfolios,
    });
  } catch (e) { next(e); }
});
