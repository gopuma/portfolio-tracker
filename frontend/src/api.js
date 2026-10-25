const BASE = import.meta.env.VITE_API_BASE || '/api';

// The backend refuses state-changing requests without this header (backend/src/security.js):
// a hostile web page can't attach it without a CORS preflight, which only this app passes.
const WRITE_HEADERS = { 'X-Requested-With': 'portfolio-tracker' };
const JSON_WRITE_HEADERS = { ...WRITE_HEADERS, 'Content-Type': 'application/json' };

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function post(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: WRITE_HEADERS });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: JSON_WRITE_HEADERS,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

async function del(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: WRITE_HEADERS });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

async function patchJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: JSON_WRITE_HEADERS,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function daysQuery(days) {
  return days != null ? `?days=${encodeURIComponent(days)}` : '';
}

export const api = {
  portfolio:    ()                       => get(`/portfolio`),
  instruments:  ()                       => get(`/instruments`),
  addInstrument: (body)                  => postJson(`/instruments`, body),
  removeInstrument: (symbol)             => del(`/instruments/${encodeURIComponent(symbol)}`),
  removeAll:    (market)                 => del(`/instruments${market ? `?market=${encodeURIComponent(market)}` : ''}`),
  instrument:   (symbol)                 => get(`/instruments/${encodeURIComponent(symbol)}`),
  prices:       (symbol, days = 90)      => get(`/prices/${encodeURIComponent(symbol)}?days=${days}`),
  fxRate:       (days = 180)             => get(`/prices/${encodeURIComponent('KRW=X')}?days=${days}`),
  fxLive:       ()                       => get(`/prices/${encodeURIComponent('KRW=X')}/live`),
  liveQuotes:   (symbols)                => get(`/prices/quotes?symbols=${encodeURIComponent((symbols || []).join(','))}`),
  vix:          (days = 180)             => get(`/prices/${encodeURIComponent('^VIX')}?days=${days}`),
  sentiment:    (symbol, days = 7)       => get(`/sentiment/${encodeURIComponent(symbol)}?days=${days}`),
  prediction:   (symbol)                 => get(`/predictions/${encodeURIComponent(symbol)}`),
  refresh:      (symbol, days)           => post(`/refresh/${encodeURIComponent(symbol)}${daysQuery(days)}`),
  refreshAll:   (days)                   => post(`/refresh${daysQuery(days)}`),
  recompute:    (symbol)                 => post(`/predictions/${encodeURIComponent(symbol)}/recompute`),
  goldGap:      ()                       => get(`/gold-gap`),
  bitcoin:      ()                       => get(`/bitcoin`),
  analytics:    (days = 365, rf = 0)     => get(`/analytics?days=${days}&rf=${rf}`),
  instrumentStats: (symbol, days = 365, rf = 0) => get(`/analytics/${encodeURIComponent(symbol)}?days=${days}&rf=${rf}`),
  optimize:     (symbols, days = 365, rf = 0) => postJson(`/analytics/optimize`, { symbols, days, rf }),
  audit:        (live = false)           => get(`/audit${live ? '?live=1' : ''}`),
  research:     (symbol, currency = 'native') => get(`/research/${encodeURIComponent(symbol)}?currency=${encodeURIComponent(currency)}`),
  ratios:       (symbol)                 => get(`/research/${encodeURIComponent(symbol)}/ratios`),

  // Portfolios
  searchSymbols: (q, market)             => get(`/instruments/search?q=${encodeURIComponent(q)}${market ? `&market=${encodeURIComponent(market)}` : ''}`),
  lookup:        (symbol)                => get(`/instruments/lookup?symbol=${encodeURIComponent(symbol)}`),
  portfolios:    ()                      => get(`/portfolios`),
  portfolioById: (id)                    => get(`/portfolios/${id}`),
  // backfillFrom ('YYYY-MM-DD') prepends hypothetical periods from that date to the first
  // recorded trade, holding the opening position constant. Read-only: nothing is stored.
  portfolioValueHistory: (id, granularity, currency, backfillFrom, includeCash) => {
    const qs = [];
    if (granularity === 'daily') qs.push('granularity=daily');
    if (currency) qs.push(`currency=${encodeURIComponent(currency)}`);
    if (backfillFrom) qs.push(`backfill_from=${encodeURIComponent(backfillFrom)}`);
    if (includeCash) qs.push('include_cash=1');
    return get(`/portfolios/${id}/value-history${qs.length ? `?${qs.join('&')}` : ''}`);
  },
  portfolioAnalytics: (id, days = 365, rf = 0) => get(`/portfolios/${id}/analytics?days=${days}&rf=${rf}`),
  stressInputs: (days, usIndex, currency) => get(`/stress?days=${days}&us_index=${encodeURIComponent(usIndex)}&currency=${currency}`),
  stressEvents: ()                      => get(`/stress/events`),
  stressReplay: (event, currency, basis) => get(`/stress/replay?event=${encodeURIComponent(event)}&currency=${currency}&basis=${basis}`),
  projectionInputs: (currency = 'KRW')  => get(`/projection/inputs?currency=${encodeURIComponent(currency)}`),
  createPortfolio: (body)                => postJson(`/portfolios`, body),
  renamePortfolio: (id, name)            => patchJson(`/portfolios/${id}`, { name }),
  deletePortfolio: (id)                  => del(`/portfolios/${id}`),
  addHolding:    (id, body)              => postJson(`/portfolios/${id}/holdings`, body),
  addCash:       (id, body)              => postJson(`/portfolios/${id}/cash`, body),
  updateHolding: (id, holdingId, body)   => patchJson(`/portfolios/${id}/holdings/${holdingId}`, body),
  removeHolding: (id, holdingId)         => del(`/portfolios/${id}/holdings/${holdingId}`),
  transactions:  (id)                    => get(`/portfolios/${id}/transactions`),
  addTransaction: (id, body)             => postJson(`/portfolios/${id}/transactions`, body),
  updateTransaction: (id, txId, body)    => patchJson(`/portfolios/${id}/transactions/${txId}`, body),
  deleteTransaction: (id, txId)          => del(`/portfolios/${id}/transactions/${txId}`),

  // Prediction competition
  leaderboard:   (horizon = 5, symbol = '') => get(`/leaderboard?horizon=${horizon}${symbol ? `&symbol=${encodeURIComponent(symbol)}` : ''}`),
  models:        ()                      => get(`/models`),
  modelPredictions: (symbol, horizon = 5) => get(`/competition/predictions/${encodeURIComponent(symbol)}?horizon=${horizon}`),
  runBacktest:   (body = {})             => postJson(`/backtest`, body),
};
