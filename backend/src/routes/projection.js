import express from 'express';
import { getFxRates } from './portfolios.js';
import { valuedPortfolios, replayable } from './stress.js';
import { replayEvent } from '../services/historicalReplay.js';

export const projectionRouter = express.Router();

// The history the Monte Carlo draws on starts here: the first month every proxy series
// (gold futures being the last to begin) has prices, so today's whole mix can be replayed.
export const HISTORY_START = '2000-09-01';

// The replay over 26 years takes a few seconds; its result only changes when new prices
// arrive, so it is kept for a while per currency.
const CACHE_MS = 6 * 60 * 60 * 1000;
const cache = new Map(); // currency -> { at, value }

/**
 * Month-end to month-end returns from a daily path of value multiples (path[i] is the
 * % change from day one), dated by the month they end in. A month still in progress (last
 * date before the 25th) is left out, so every return covers a whole month.
 */
export function monthlyReturns(dates, path) {
  const ends = [];
  for (let i = 0; i < dates.length; i++) {
    const last = i === dates.length - 1;
    if (last && Number(dates[i].slice(8, 10)) < 25) continue;
    if (last || dates[i + 1].slice(0, 7) !== dates[i].slice(0, 7)) ends.push(i);
  }
  return ends.slice(1).map((i, k) => ({
    month: dates[i].slice(0, 7),
    r: +((1 + path[i]) / (1 + path[ends[k]]) - 1).toFixed(6),
  }));
}

/**
 * Monthly returns of a portfolio held at constant weights (rebalanced each month), from
 * each holding's own monthly returns. The projection holds today's mix constant, so its
 * history must too: a buy-and-hold replay lets 26 years of winners crowd out the cash.
 */
export function rebalancedReturns(holdings, returnsByKey) {
  const total = holdings.reduce((a, h) => a + h.value, 0);
  const n = Math.min(...holdings.map(h => returnsByKey.get(h.key).length));
  const out = new Array(n).fill(0);
  for (const h of holdings) {
    const r = returnsByKey.get(h.key);
    for (let i = 0; i < n; i++) out[i] += (h.value / total) * r[i];
  }
  return out.map(x => +x.toFixed(6));
}

const holdingKey = h => (h.is_cash ? `CASH:${h.currency}` : h.symbol);

async function build(currency) {
  const fx = await getFxRates();
  const { portfolios, held } = await valuedPortfolios(currency, fx);
  const { shown, meta } = await replayable(portfolios, held);

  // One pseudo-portfolio per distinct holding, so the replay hands back each one's path.
  const pseudo = new Map();
  for (const p of shown) {
    for (const h of p.holdings) {
      const key = holdingKey(h);
      if (!pseudo.has(key)) pseudo.set(key, { id: key, name: key, total: 1, holdings: [{ ...h, value: 1 }] });
    }
  }
  const rep = pseudo.size === 0 ? null : await replayEvent(
    { key: 'projection', kind: 'boom', label: 'Projection history', start: HISTORY_START, end: null, note: '' },
    [...pseudo.values()], meta, currency, 'factor'
  );
  const returnsByKey = new Map((rep?.portfolios || []).map(p => [p.id, monthlyReturns(rep.dates, p.path)]));
  const months = rep ? (returnsByKey.values().next().value || []).map(m => m.month) : [];
  for (const [k, v] of returnsByKey) returnsByKey.set(k, v.map(m => m.r));

  return {
    currency,
    krw_per_usd: fx.krwPerUsd,
    history_from: rep?.event.first_date || null,
    history_to: rep?.event.last_date || null,
    months,
    portfolios: shown.map(p => {
      // Cash in the display currency is split out: the projection gives it its own rate
      // (inflation plus a margin, like a savings account) instead of history's 0%.
      const isHomeCash = h => h.is_cash && h.currency === currency;
      const cash = p.holdings.filter(isHomeCash).reduce((a, h) => a + h.value, 0);
      const invested = p.holdings.filter(h => !isHomeCash(h)).map(h => ({ key: holdingKey(h), value: h.value }));
      return {
        id: p.id,
        name: p.name,
        value: p.total,
        cash,
        monthly: rep && invested.length ? rebalancedReturns(invested, returnsByKey) : [],
      };
    }),
  };
}

/**
 * Inputs for the portfolio projection: each portfolio's value today in the display
 * currency, how much of it is cash in that currency, and the monthly returns its other
 * (invested) holdings would have had since 2000
 * (factor basis: every holding follows its proxy index at today's beta, as in the
 * historical replay). The Monte Carlo itself runs in the browser.
 * Query: ?currency=USD|KRW
 */
projectionRouter.get('/inputs', async (req, res, next) => {
  try {
    const currency = req.query.currency === 'USD' ? 'USD' : 'KRW';
    const hit = cache.get(currency);
    if (hit && Date.now() - hit.at < CACHE_MS && req.query.fresh !== '1') return res.json(hit.value);
    const value = await build(currency);
    cache.set(currency, { at: Date.now(), value });
    res.json(value);
  } catch (e) { next(e); }
});
