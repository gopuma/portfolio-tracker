/**
 * Portfolio roll-up math. Locks in that window returns (1Y/3Y/5Y) are weighted by
 * each holding's value at the START of the window — the realized buy-and-hold
 * return — rather than by current value (which would overweight winners).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computePortfolio } from '../src/routes/portfolios.js';

// Helper to build a holding row the way loadHoldings() returns it.
const row = (o) => ({
  id: o.id, symbol: o.symbol, account: '', display_name: o.symbol,
  currency: o.currency || 'USD', shares: o.shares, cost_price: o.cost_price,
  latest_close: o.latest_close,
  close_1y: o.close_1y ?? null, close_3y: o.close_3y ?? null, close_5y: o.close_5y ?? null,
});

test('1Y return is start-of-window value-weighted, not current-value weighted', () => {
  // A doubled (+100%), B flat (0%); each started at $100. True portfolio:
  // start 200 -> now 300 => +50%. Current-value weighting would wrongly give 66.7%.
  const rows = [
    row({ id: 1, symbol: 'A', shares: 1, cost_price: 100, latest_close: 200, close_1y: 100 }),
    row({ id: 2, symbol: 'B', shares: 1, cost_price: 100, latest_close: 100, close_1y: 100 }),
  ];
  const { holdings, totals } = computePortfolio(rows, 'USD', null);

  // Per-holding returns unchanged (price returns).
  assert.equal(holdings.find(h => h.symbol === 'A').return_1y, 1);
  assert.equal(holdings.find(h => h.symbol === 'B').return_1y, 0);

  // Current-allocation weights still reflect current value (A=2/3, B=1/3).
  assert.ok(Math.abs(holdings.find(h => h.symbol === 'A').weight - 2 / 3) < 1e-12);

  // The fix: portfolio 1Y = 50%, NOT 66.7%.
  assert.ok(Math.abs(totals.return_1y - 0.5) < 1e-12);
});

test('holdings missing a window price are excluded from that window return', () => {
  // C has no close_1y, so it must not drag the 1Y figure. A: +20% on $100 start.
  const rows = [
    row({ id: 1, symbol: 'A', shares: 1, cost_price: 100, latest_close: 120, close_1y: 100 }),
    row({ id: 2, symbol: 'C', shares: 1, cost_price: 50, latest_close: 80, close_1y: null }),
  ];
  const { totals } = computePortfolio(rows, 'USD', null);
  assert.ok(Math.abs(totals.return_1y - 0.2) < 1e-12);
});

test('return_1y is null when no holding has a window price', () => {
  const rows = [row({ id: 1, symbol: 'A', shares: 1, cost_price: 100, latest_close: 120, close_1y: null })];
  const { totals } = computePortfolio(rows, 'USD', null);
  assert.equal(totals.return_1y, null);
});

test('multi-share weighting: shares scale the start/end values', () => {
  // A: 10 sh, +50% ($10 -> $15), start value 100. B: 1 sh, -10% ($100 -> $90), start 100.
  // start 200 -> end 150 + 90 = 240 => +20%.
  const rows = [
    row({ id: 1, symbol: 'A', shares: 10, cost_price: 10, latest_close: 15, close_1y: 10 }),
    row({ id: 2, symbol: 'B', shares: 1, cost_price: 100, latest_close: 90, close_1y: 100 }),
  ];
  const { totals } = computePortfolio(rows, 'USD', null);
  assert.ok(Math.abs(totals.return_1y - 0.2) < 1e-12);
});

// A cash equivalent row as loadHoldings() returns it (symbol CASH:<CCY>, no prices).
const cashRow = (o) => ({
  id: o.id, symbol: `CASH:${o.currency || 'USD'}`, account: o.account || '',
  display_name: null, currency: o.currency || 'USD', shares: o.amount, cost_price: 1,
  latest_close: null, close_ytd: null, close_1y: null, close_3y: null, close_5y: null,
});

test('cash is valued 1:1 and counted in market value and weights', () => {
  // $150 of stock (1 sh @150) + $50 cash => MV 200, gain 50 (stock only), cash weight 25%.
  const rows = [
    row({ id: 1, symbol: 'A', shares: 1, cost_price: 100, latest_close: 150 }),
    cashRow({ id: 2, amount: 50 }),
  ];
  const { holdings, totals } = computePortfolio(rows, 'USD', null);

  const cash = holdings.find(h => h.is_cash);
  assert.equal(cash.market_value_base, 50);
  assert.equal(cash.return_inception, 0);
  assert.ok(Math.abs(cash.weight - 0.25) < 1e-12);

  assert.equal(totals.market_value, 200);
  assert.equal(totals.gain, 50);
});

test('inception return is securities-only (cash does not dilute it)', () => {
  // Stock +50% ($100 -> $150). Adding $1000 cash must NOT pull inception toward 0.
  const rows = [
    row({ id: 1, symbol: 'A', shares: 1, cost_price: 100, latest_close: 150 }),
    cashRow({ id: 2, amount: 1000 }),
  ];
  const { totals } = computePortfolio(rows, 'USD', null);
  assert.ok(Math.abs(totals.return_inception - 0.5) < 1e-12);
});

test('cash converts to base currency at the given FX', () => {
  // KRW base, USD cash of $100 at 1300 KRW/USD => 130,000 KRW.
  const rows = [cashRow({ id: 1, amount: 100, currency: 'USD' })];
  const { holdings, totals } = computePortfolio(rows, 'KRW', 1300);
  assert.equal(holdings[0].market_value_base, 130000);
  assert.equal(totals.market_value, 130000);
});
