/**
 * Monthly total-asset-value roll-up for the value bar chart. Verifies the full-basket
 * month intersection, share scaling, FX conversion, and the empty/insufficient cases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlyPortfolioValues } from '../src/routes/portfolios.js';

test('sums shares × monthly-avg close per month (USD only)', () => {
  const holdings = [
    { instrument_id: 1, shares: 2, currency: 'USD' },
    { instrument_id: 2, shares: 1, currency: 'USD' },
  ];
  const priceRows = [
    { instrument_id: 1, ym: '2024-01', avg_close: 100 },
    { instrument_id: 2, ym: '2024-01', avg_close: 50 },
    { instrument_id: 1, ym: '2024-02', avg_close: 110 },
    { instrument_id: 2, ym: '2024-02', avg_close: 50 },
  ];
  const pts = monthlyPortfolioValues(holdings, priceRows, [], 'USD');
  assert.deepEqual(pts, [
    { month: '2024-01', value: 2 * 100 + 1 * 50 }, // 250
    { month: '2024-02', value: 2 * 110 + 1 * 50 }, // 270
  ]);
});

test('only full-basket months are returned (intersection of holdings)', () => {
  // Instrument 2 has no Dec data, so 2023-12 is excluded even though instrument 1 has it.
  const holdings = [
    { instrument_id: 1, shares: 1, currency: 'USD' },
    { instrument_id: 2, shares: 1, currency: 'USD' },
  ];
  const priceRows = [
    { instrument_id: 1, ym: '2023-12', avg_close: 100 },
    { instrument_id: 1, ym: '2024-01', avg_close: 120 },
    { instrument_id: 2, ym: '2024-01', avg_close: 30 },
  ];
  const pts = monthlyPortfolioValues(holdings, priceRows, [], 'USD');
  assert.deepEqual(pts, [{ month: '2024-01', value: 150 }]);
});

test('converts KRW holdings to USD base at the month-average FX', () => {
  const holdings = [{ instrument_id: 1, shares: 10, currency: 'KRW' }];
  const priceRows = [
    { instrument_id: 1, ym: '2024-01', avg_close: 1300 }, // KRW price
    { instrument_id: 1, ym: '2024-02', avg_close: 1300 },
  ];
  const fxRows = [
    { ym: '2024-01', avg_fx: 1300 }, // 1300 KRW per USD -> 10*1300/1300 = 10 USD
    // 2024-02 has no FX -> excluded for a cross-currency holding
  ];
  const pts = monthlyPortfolioValues(holdings, priceRows, fxRows, 'USD');
  assert.deepEqual(pts, [{ month: '2024-01', value: 10 }]);
});

test('empty holdings and missing price history yield no points', () => {
  assert.deepEqual(monthlyPortfolioValues([], [], [], 'USD'), []);
  const holdings = [{ instrument_id: 9, shares: 1, currency: 'USD' }];
  assert.deepEqual(monthlyPortfolioValues(holdings, [], [], 'USD'), []);
});
