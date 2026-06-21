/**
 * Monthly total-asset-value roll-up for the stacked value bar chart. Verifies the
 * per-stock breakdown, full-basket month intersection, lot combining, share scaling,
 * FX conversion, the `since` floor, and the empty/insufficient cases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlyPortfolioValues } from '../src/routes/portfolios.js';

const h = (o) => ({ instrument_id: o.instrument_id, symbol: o.symbol, name: o.name || o.symbol, shares: o.shares, currency: o.currency || 'USD' });
// value of stock `sym` in a point, via the symbols key map.
const valOf = (res, point, sym) => point[res.symbols.find(s => s.symbol === sym).key];

test('breaks the monthly total down by stock (USD only)', () => {
  const holdings = [h({ instrument_id: 1, symbol: 'A', shares: 2 }), h({ instrument_id: 2, symbol: 'B', shares: 1 })];
  const priceRows = [
    { instrument_id: 1, ym: '2024-01', avg_close: 100 },
    { instrument_id: 2, ym: '2024-01', avg_close: 50 },
    { instrument_id: 1, ym: '2024-02', avg_close: 110 },
    { instrument_id: 2, ym: '2024-02', avg_close: 50 },
  ];
  const res = monthlyPortfolioValues(holdings, priceRows, [], 'USD');
  assert.deepEqual(res.symbols.map(s => s.symbol).sort(), ['A', 'B']);
  assert.equal(res.points.length, 2);
  assert.equal(res.points[0].total, 250);          // 2*100 + 1*50
  assert.equal(valOf(res, res.points[0], 'A'), 200);
  assert.equal(valOf(res, res.points[0], 'B'), 50);
  assert.equal(res.points[1].total, 270);          // 2*110 + 1*50
});

test('stack is ordered by the latest month value, largest first', () => {
  const holdings = [h({ instrument_id: 1, symbol: 'SMALL', shares: 1 }), h({ instrument_id: 2, symbol: 'BIG', shares: 1 })];
  const priceRows = [
    { instrument_id: 1, ym: '2024-01', avg_close: 10 },
    { instrument_id: 2, ym: '2024-01', avg_close: 90 },
  ];
  const res = monthlyPortfolioValues(holdings, priceRows, [], 'USD');
  assert.deepEqual(res.symbols.map(s => s.symbol), ['BIG', 'SMALL']);
  assert.equal(res.symbols[0].key, 's0');
});

test('combines lots of the same symbol into one stock', () => {
  const holdings = [
    h({ instrument_id: 1, symbol: 'A', shares: 2 }),
    h({ instrument_id: 1, symbol: 'A', shares: 3 }), // second lot, same symbol
  ];
  const priceRows = [{ instrument_id: 1, ym: '2024-01', avg_close: 100 }];
  const res = monthlyPortfolioValues(holdings, priceRows, [], 'USD');
  assert.equal(res.symbols.length, 1);
  assert.equal(res.points[0].total, 500); // (2+3) * 100
});

test('only full-basket months are returned (intersection of stocks)', () => {
  const holdings = [h({ instrument_id: 1, symbol: 'A', shares: 1 }), h({ instrument_id: 2, symbol: 'B', shares: 1 })];
  const priceRows = [
    { instrument_id: 1, ym: '2023-12', avg_close: 100 }, // B has no Dec -> excluded
    { instrument_id: 1, ym: '2024-01', avg_close: 120 },
    { instrument_id: 2, ym: '2024-01', avg_close: 30 },
  ];
  const res = monthlyPortfolioValues(holdings, priceRows, [], 'USD');
  assert.deepEqual(res.points.map(p => p.month), ['2024-01']);
  assert.equal(res.points[0].total, 150);
});

test('converts KRW holdings to USD base at the month-average FX', () => {
  const holdings = [h({ instrument_id: 1, symbol: 'K', shares: 10, currency: 'KRW' })];
  const priceRows = [
    { instrument_id: 1, ym: '2024-01', avg_close: 1300 },
    { instrument_id: 1, ym: '2024-02', avg_close: 1300 },
  ];
  const fxRows = [{ ym: '2024-01', avg_fx: 1300 }]; // 2024-02 has no FX -> excluded
  const res = monthlyPortfolioValues(holdings, priceRows, fxRows, 'USD');
  assert.deepEqual(res.points.map(p => p.month), ['2024-01']);
  assert.equal(res.points[0].total, 10); // 10 * 1300 / 1300
});

test('since floors the series at the given month', () => {
  const holdings = [h({ instrument_id: 1, symbol: 'A', shares: 1 })];
  const priceRows = [
    { instrument_id: 1, ym: '2026-01', avg_close: 100 },
    { instrument_id: 1, ym: '2026-02', avg_close: 110 },
    { instrument_id: 1, ym: '2026-03', avg_close: 120 },
  ];
  const res = monthlyPortfolioValues(holdings, priceRows, [], 'USD', '2026-02');
  assert.deepEqual(res.points.map(p => p.month), ['2026-02', '2026-03']);
});

test('empty holdings and missing price history yield no points', () => {
  assert.deepEqual(monthlyPortfolioValues([], [], [], 'USD'), { symbols: [], points: [] });
  const holdings = [h({ instrument_id: 9, symbol: 'A', shares: 1 })];
  assert.deepEqual(monthlyPortfolioValues(holdings, [], [], 'USD'), { symbols: [], points: [] });
});
