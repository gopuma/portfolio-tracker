const BASE = import.meta.env.VITE_API_BASE || '/api';

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function post(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

async function del(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

async function patchJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
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
  vix:          (days = 180)             => get(`/prices/${encodeURIComponent('^VIX')}?days=${days}`),
  sentiment:    (symbol, days = 7)       => get(`/sentiment/${encodeURIComponent(symbol)}?days=${days}`),
  prediction:   (symbol)                 => get(`/predictions/${encodeURIComponent(symbol)}`),
  refresh:      (symbol, days)           => post(`/refresh/${encodeURIComponent(symbol)}${daysQuery(days)}`),
  refreshAll:   (days)                   => post(`/refresh${daysQuery(days)}`),
  recompute:    (symbol)                 => post(`/predictions/${encodeURIComponent(symbol)}/recompute`),
  goldGap:      ()                       => get(`/gold-gap`),
  analytics:    (days = 365, rf = 0)     => get(`/analytics?days=${days}&rf=${rf}`),
  instrumentStats: (symbol, days = 365, rf = 0) => get(`/analytics/${encodeURIComponent(symbol)}?days=${days}&rf=${rf}`),
  optimize:     (symbols, days = 365, rf = 0) => postJson(`/analytics/optimize`, { symbols, days, rf }),
  audit:        (live = false)           => get(`/audit${live ? '?live=1' : ''}`),

  // Portfolios
  searchSymbols: (q, market)             => get(`/instruments/search?q=${encodeURIComponent(q)}${market ? `&market=${encodeURIComponent(market)}` : ''}`),
  lookup:        (symbol)                => get(`/instruments/lookup?symbol=${encodeURIComponent(symbol)}`),
  portfolios:    ()                      => get(`/portfolios`),
  portfolioById: (id)                    => get(`/portfolios/${id}`),
  portfolioValueHistory: (id)            => get(`/portfolios/${id}/value-history`),
  createPortfolio: (body)                => postJson(`/portfolios`, body),
  renamePortfolio: (id, name)            => patchJson(`/portfolios/${id}`, { name }),
  deletePortfolio: (id)                  => del(`/portfolios/${id}`),
  addHolding:    (id, body)              => postJson(`/portfolios/${id}/holdings`, body),
  updateHolding: (id, holdingId, body)   => patchJson(`/portfolios/${id}/holdings/${holdingId}`, body),
  removeHolding: (id, holdingId)         => del(`/portfolios/${id}/holdings/${holdingId}`),

  // Prediction competition
  leaderboard:   (horizon = 5, symbol = '') => get(`/leaderboard?horizon=${horizon}${symbol ? `&symbol=${encodeURIComponent(symbol)}` : ''}`),
  models:        ()                      => get(`/models`),
  modelPredictions: (symbol, horizon = 5) => get(`/competition/predictions/${encodeURIComponent(symbol)}?horizon=${horizon}`),
  runBacktest:   (body = {})             => postJson(`/backtest`, body),
};
