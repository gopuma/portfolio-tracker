/**
 * Composition-aware monthly AVERAGE total-asset-value roll-up. Verifies daily-price
 * averaging within a month, intra-month holding changes (buy/sell) reconstructed from
 * the change log, deletes, lot combining, FX conversion, the as-of price fallback, and
 * the empty case.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlyAverageValues, dailyValues } from '../src/routes/portfolios.js';

// event helper. action defaults to 'set'.
let _id = 0;
const ev = (o) => ({
  id: o.id ?? ++_id,
  holding_id: o.holding_id,
  symbol: o.symbol,
  name: o.name || o.symbol,
  instrument_id: o.instrument_id,
  currency: o.currency || 'USD',
  shares: o.shares ?? 0,
  action: o.action || 'set',
  effective_date: o.effective_date,
});
const px = (instrument_id, date, close) => ({ instrument_id, date, close });
const valOf = (res, point, sym) => point[res.symbols.find(s => s.symbol === sym).key];

test('averages the daily total across a month (prices move day to day)', () => {
  const events = [ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 10, effective_date: '2026-01-01' })];
  const prices = [
    px(1, '2026-01-05', 100),
    px(1, '2026-01-06', 110),
    px(1, '2026-01-07', 120), // avg close 110 -> 10 * 110 = 1100
  ];
  const res = monthlyAverageValues(events, prices, [], 'USD');
  assert.deepEqual(res.points.map(p => p.month), ['2026-01']);
  assert.equal(res.points[0].total, 1100);
});

test('reflects an intra-month buy: average weights the days each share count was held', () => {
  const events = [
    ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 10, effective_date: '2026-02-01' }),
    ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 20, effective_date: '2026-02-03' }), // bought more mid-month
  ];
  const prices = [
    px(1, '2026-02-02', 100), // 10 * 100 = 1000
    px(1, '2026-02-03', 100), // 20 * 100 = 2000
    px(1, '2026-02-04', 100), // 20 * 100 = 2000
  ];
  const res = monthlyAverageValues(events, prices, [], 'USD');
  assert.equal(res.points[0].total, (1000 + 2000 + 2000) / 3); // ≈ 1666.67
});

test('tracks month over month as holdings change', () => {
  const events = [
    ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 10, effective_date: '2026-01-01' }),
    ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 5, effective_date: '2026-02-01' }), // sold half in Feb
  ];
  const prices = [px(1, '2026-01-15', 100), px(1, '2026-02-15', 100)];
  const res = monthlyAverageValues(events, prices, [], 'USD');
  assert.deepEqual(res.points.map(p => p.month), ['2026-01', '2026-02']);
  assert.equal(res.points[0].total, 1000); // 10 * 100
  assert.equal(res.points[1].total, 500);  // 5 * 100
});

test('a delete stops the lot from counting afterwards', () => {
  const events = [
    ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 10, effective_date: '2026-01-01' }),
    ev({ holding_id: 1, instrument_id: 1, symbol: 'A', action: 'delete', effective_date: '2026-02-01' }),
  ];
  const prices = [px(1, '2026-01-15', 100), px(1, '2026-02-15', 100)];
  const res = monthlyAverageValues(events, prices, [], 'USD');
  assert.deepEqual(res.points.map(p => p.month), ['2026-01']); // Feb has no holdings -> no point
});

test('combines lots of the same symbol (different accounts)', () => {
  const events = [
    ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 2, effective_date: '2026-01-01' }),
    ev({ holding_id: 2, instrument_id: 1, symbol: 'A', shares: 3, effective_date: '2026-01-01' }),
  ];
  const prices = [px(1, '2026-01-10', 10)];
  const res = monthlyAverageValues(events, prices, [], 'USD');
  assert.equal(res.symbols.filter(s => s.symbol === 'A').length, 1);
  assert.equal(res.points[0].total, 50); // (2+3) * 10
});

test('converts KRW holdings to USD base at the daily FX', () => {
  const events = [ev({ holding_id: 1, instrument_id: 1, symbol: 'K', shares: 10, currency: 'KRW', effective_date: '2026-01-01' })];
  const prices = [px(1, '2026-01-10', 1300)];
  const fx = [{ date: '2026-01-10', fx: 1300 }];
  const res = monthlyAverageValues(events, prices, fx, 'USD');
  assert.equal(res.points[0].total, 10); // 10 * 1300 / 1300
});

test('uses the latest earlier close when a day has no price for an instrument', () => {
  const events = [
    ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 1, effective_date: '2026-01-01' }),
    ev({ holding_id: 2, instrument_id: 2, symbol: 'B', shares: 1, effective_date: '2026-01-01' }),
  ];
  // B has a price only on the 5th; on the 6th (A trades) B falls back to its 5th close.
  const prices = [px(1, '2026-01-05', 100), px(2, '2026-01-05', 50), px(1, '2026-01-06', 100)];
  const res = monthlyAverageValues(events, prices, [], 'USD');
  // day 5: 100 + 50 = 150 ; day 6: 100 + 50 (B carried) = 150 -> avg 150
  assert.equal(res.points[0].total, 150);
  assert.equal(valOf(res, res.points[0], 'B'), 50);
});

test('no events yields no points', () => {
  assert.deepEqual(monthlyAverageValues([], [], [], 'USD'), { symbols: [], points: [] });
});

test('dailyValues: one point per trading day, each at that day\'s close', () => {
  const events = [ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 10, effective_date: '2026-01-01' })];
  const prices = [px(1, '2026-01-05', 100), px(1, '2026-01-06', 110), px(1, '2026-01-07', 120)];
  const res = dailyValues(events, prices, [], 'USD');
  assert.deepEqual(res.points.map(p => p.date), ['2026-01-05', '2026-01-06', '2026-01-07']);
  assert.deepEqual(res.points.map(p => p.total), [1000, 1100, 1200]); // not averaged
});

test('dailyValues: reflects an intra-month buy from the buy date onward', () => {
  const events = [
    ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 10, effective_date: '2026-02-01' }),
    ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 20, effective_date: '2026-02-03' }),
  ];
  const prices = [px(1, '2026-02-02', 100), px(1, '2026-02-03', 100), px(1, '2026-02-04', 100)];
  const res = dailyValues(events, prices, [], 'USD');
  assert.deepEqual(res.points.map(p => p.total), [1000, 2000, 2000]);
});

test('dailyValues: empty events yield no points', () => {
  assert.deepEqual(dailyValues([], [], [], 'USD'), { symbols: [], points: [] });
});
