/**
 * Composition-aware monthly total-asset-value roll-up. Verifies daily-price averaging of
 * SECURITIES within a month, cash taking the month's CLOSING balance instead, intra-month
 * holding changes (buy/sell) reconstructed from the change log, deletes, lot combining,
 * FX conversion, the as-of price fallback, backfilled pre-history, and the empty case.
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

test('dailyValues: each point carries the FX rate it was valued at', () => {
  const events = [ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 1, effective_date: '2026-01-01' })];
  const prices = [px(1, '2026-01-05', 100), px(1, '2026-01-06', 100)];
  const fx = [{ date: '2026-01-05', fx: 1300 }, { date: '2026-01-06', fx: 1400 }];
  const res = dailyValues(events, prices, fx, 'USD');
  assert.deepEqual(res.points.map(p => p.fx), [1300, 1400]);
});

test('monthly points carry the month\'s average FX (days without a rate are skipped)', () => {
  const events = [ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 1, effective_date: '2026-01-01' })];
  const prices = [px(1, '2026-01-05', 100), px(1, '2026-01-06', 100), px(1, '2026-02-05', 100)];
  // No rate before the 6th: January averages the one day it has; February carries it forward.
  const fx = [{ date: '2026-01-06', fx: 1300 }, { date: '2026-02-05', fx: 1500 }];
  const res = monthlyAverageValues(events, prices, fx, 'USD');
  assert.deepEqual(res.points.map(p => p.fx), [1300, 1500]);
});

test('points carry a null FX when no rate is known at all', () => {
  const events = [ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 1, effective_date: '2026-01-01' })];
  const res = monthlyAverageValues(events, [px(1, '2026-01-05', 100)], [], 'USD');
  assert.equal(res.points[0].fx, null);
});

test('backfill: carries the opening composition back over earlier priced days', () => {
  const events = [ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 10, effective_date: '2026-01-01' })];
  const prices = [px(1, '2025-11-14', 90), px(1, '2025-12-15', 80), px(1, '2026-01-05', 100)];
  const res = monthlyAverageValues(events, prices, [], 'USD', '2025-01-01');
  assert.deepEqual(res.points.map(p => p.month), ['2025-11', '2025-12', '2026-01']);
  assert.deepEqual(res.points.map(p => p.total), [900, 800, 1000]); // same 10 shares throughout
  assert.deepEqual(res.points.map(p => !!p.backfill), [true, true, false]);
});

test('backfill: only reaches back to the requested date', () => {
  const events = [ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 1, effective_date: '2026-01-01' })];
  const prices = [px(1, '2025-06-10', 10), px(1, '2025-12-10', 10), px(1, '2026-01-05', 10)];
  const res = monthlyAverageValues(events, prices, [], 'USD', '2025-10-01');
  assert.deepEqual(res.points.map(p => p.month), ['2025-12', '2026-01']); // June is before the start
});

test('backfill: a lot with no price yet (listed later) is left out of earlier periods', () => {
  const events = [
    ev({ holding_id: 1, instrument_id: 1, symbol: 'OLD', shares: 1, effective_date: '2026-01-01' }),
    ev({ holding_id: 2, instrument_id: 2, symbol: 'NEW', shares: 1, effective_date: '2026-01-01' }),
  ];
  const prices = [
    px(1, '2025-06-10', 100), px(1, '2025-09-10', 100), px(1, '2026-01-05', 100),
    px(2, '2025-09-10', 50), px(2, '2026-01-05', 50), // NEW only lists in September
  ];
  const res = monthlyAverageValues(events, prices, [], 'USD', '2025-01-01');
  assert.deepEqual(res.points.map(p => p.total), [100, 150, 150]); // June has OLD only
  assert.equal(res.points[0].NEW, undefined);
});

test('backfill: shares are held at the opening position, not a later one', () => {
  const events = [
    ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 10, effective_date: '2026-01-01' }),
    ev({ holding_id: 2, instrument_id: 2, symbol: 'B', shares: 7, effective_date: '2026-06-01' }), // bought later
  ];
  const prices = [px(1, '2025-06-10', 10), px(2, '2025-06-10', 10), px(1, '2026-01-05', 10), px(2, '2026-01-05', 10)];
  const res = monthlyAverageValues(events, prices, [], 'USD', '2025-01-01');
  assert.equal(res.points[0].total, 100); // B is not projected back — it wasn't held
});

test('backfill: a lot with real history BEFORE the opening date keeps it, and the rest of the stack is still projected alongside', () => {
  // Mirrors an RSU vest dated to when it actually vested, against a position imported in
  // one lump: 'RSU' starts 2025-04, everything else on the 2026-01 opening date.
  const events = [
    ev({ holding_id: 1, instrument_id: 1, symbol: 'RSU', shares: 34, effective_date: '2025-04-15' }),
    ev({ holding_id: 1, instrument_id: 1, symbol: 'RSU', shares: 136, effective_date: '2025-10-15' }),
    ev({ holding_id: 2, instrument_id: 2, symbol: 'B', shares: 10, effective_date: '2026-01-01' }),
    ev({ holding_id: 3, instrument_id: 3, symbol: 'C', shares: 20, effective_date: '2026-01-01' }),
  ];
  const prices = [];
  for (const d of ['2025-02-10', '2025-06-10', '2025-11-10', '2026-02-10']) {
    prices.push(px(1, d, 10), px(2, d, 10), px(3, d, 10));
  }
  const res = dailyValues(events, prices, [], 'USD', '2025-01-01');
  const at = d => res.points.find(p => p.date === d);

  // Before the RSU's own start: it is projected at its opening 34, B and C projected too.
  assert.equal(valOf(res, at('2025-02-10'), 'RSU'), 340);
  assert.equal(at('2025-02-10').total, 340 + 100 + 200);
  // After it vests but before the opening date: RSU is REAL, B and C still projected —
  // the stack stays whole instead of collapsing to the one lot that has history.
  assert.equal(valOf(res, at('2025-06-10'), 'RSU'), 340);   // real 34 shares
  assert.equal(valOf(res, at('2025-11-10'), 'RSU'), 1360);  // real 136 after the 2nd vest
  assert.equal(valOf(res, at('2025-11-10'), 'B'), 100);     // still projected
  assert.deepEqual([at('2025-02-10'), at('2025-06-10'), at('2025-11-10')].map(p => !!p.backfill), [true, true, true]);
  // From the opening date on, nothing is projected.
  assert.equal(at('2026-02-10').backfill, undefined);
  assert.equal(at('2026-02-10').total, 1360 + 100 + 200);
});

test('backfill: the opening date is the day the most lots begin, not the earliest event', () => {
  const events = [
    ev({ holding_id: 1, instrument_id: 1, symbol: 'EARLY', shares: 1, effective_date: '2025-04-15' }),
    ev({ holding_id: 2, instrument_id: 2, symbol: 'B', shares: 1, effective_date: '2026-01-01' }),
    ev({ holding_id: 3, instrument_id: 3, symbol: 'C', shares: 1, effective_date: '2026-01-01' }),
    ev({ holding_id: 4, instrument_id: 4, symbol: 'LATER', shares: 1, effective_date: '2026-06-01' }),
  ];
  const prices = [];
  for (const d of ['2025-06-10', '2026-03-10']) for (const i of [1, 2, 3, 4]) prices.push(px(i, d, 100));
  const res = dailyValues(events, prices, [], 'USD', '2025-01-01');
  const early = res.points.find(p => p.date === '2025-06-10');
  // Opening date is 2026-01-01 (two lots). B and C project back; LATER never does.
  assert.equal(early.total, 300); // EARLY real + B + C projected — no LATER
  const after = res.points.find(p => p.date === '2026-03-10');
  assert.equal(after.total, 300); // LATER still absent: it genuinely wasn't held yet
});

test('backfill: a start date the ledger already covers changes nothing', () => {
  const events = [ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 1, effective_date: '2026-01-01' })];
  const prices = [px(1, '2026-01-05', 10)];
  const plain = monthlyAverageValues(events, prices, [], 'USD');
  const asked = monthlyAverageValues(events, prices, [], 'USD', '2026-06-01');
  assert.deepEqual(asked, plain);
});

test('backfill: synthetic days convert at that day\'s real FX', () => {
  const events = [ev({ holding_id: 1, instrument_id: 1, symbol: 'K', shares: 10, currency: 'KRW', effective_date: '2026-01-01' })];
  const prices = [px(1, '2025-06-10', 1300), px(1, '2026-01-05', 1300)];
  const fx = [{ date: '2025-06-10', fx: 1300 }, { date: '2026-01-05', fx: 1000 }];
  const res = dailyValues(events, prices, fx, 'USD', '2025-01-01');
  assert.deepEqual(res.points.map(p => p.total), [10, 13]); // same shares, different rate
  assert.deepEqual(res.points.map(p => p.fx), [1300, 1000]);
});

// --- cash in the stack (the "+ Cash" toggle) --------------------------------
// Cash reaches the walk as CASH:<CCY> events with no instrument_id; it's worth its face
// amount in its own currency and converts at the same daily rate as every other lot.
const cashEv = (o) => ev({ ...o, symbol: `CASH:${o.currency}`, instrument_id: null });

test('cash is valued at face and converted at the day\'s FX', () => {
  const events = [
    ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 1, effective_date: '2026-01-01' }),
    cashEv({ holding_id: 2, currency: 'KRW', shares: 1300000, effective_date: '2026-01-01' }),
  ];
  const prices = [px(1, '2026-01-05', 100)];
  const fx = [{ date: '2026-01-05', fx: 1300 }];
  const res = dailyValues(events, prices, fx, 'USD');
  assert.equal(valOf(res, res.points[0], 'CASH:KRW'), 1000); // 1,300,000 / 1300
  assert.equal(res.points[0].total, 1100);                   // + the $100 stock
});

test('cash converts the other way too (USD cash into a KRW base)', () => {
  const events = [
    ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 1, currency: 'KRW', effective_date: '2026-01-01' }),
    cashEv({ holding_id: 2, currency: 'USD', shares: 100, effective_date: '2026-01-01' }),
  ];
  const prices = [px(1, '2026-01-05', 5000)];
  const fx = [{ date: '2026-01-05', fx: 1300 }];
  const res = dailyValues(events, prices, fx, 'KRW');
  assert.equal(valOf(res, res.points[0], 'CASH:USD'), 130000);
});

test('cash needs no price row of its own to be valued', () => {
  // Only the stock has prices; the cash lot still shows up on that stock's trading days.
  const events = [
    ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 1, effective_date: '2026-01-01' }),
    cashEv({ holding_id: 2, currency: 'USD', shares: 500, effective_date: '2026-01-01' }),
  ];
  const res = dailyValues(events, [px(1, '2026-01-05', 100)], [], 'USD');
  assert.equal(valOf(res, res.points[0], 'CASH:USD'), 500);
  assert.equal(res.points[0].total, 600);
});

test('monthly cash is the closing balance, not an average of the days it existed', () => {
  const events = [
    ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 1, effective_date: '2026-01-01' }),
    cashEv({ holding_id: 2, currency: 'USD', shares: 300, effective_date: '2026-01-06' }),
  ];
  const prices = [px(1, '2026-01-05', 100), px(1, '2026-01-06', 100), px(1, '2026-01-07', 100)];
  const res = monthlyAverageValues(events, prices, [], 'USD');
  // Deposited on the 6th but shown in full: a balance is a balance, not a day-weighted mean.
  assert.equal(valOf(res, res.points[0], 'CASH:USD'), 300);
  assert.equal(res.points[0].total, 400); // 100 averaged stock + 300 closing cash
});

test('securities are still averaged even though cash is not', () => {
  const events = [
    ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 1, effective_date: '2026-01-01' }),
    cashEv({ holding_id: 2, currency: 'USD', shares: 50, effective_date: '2026-01-01' }),
  ];
  const prices = [px(1, '2026-01-05', 100), px(1, '2026-01-06', 200)]; // avg 150
  const res = monthlyAverageValues(events, prices, [], 'USD');
  assert.equal(valOf(res, res.points[0], 'A'), 150);
  assert.equal(valOf(res, res.points[0], 'CASH:USD'), 50);
  assert.equal(res.points[0].total, 200); // the bar's total is the sum of its bands
});

test('cash withdrawn to zero mid-month leaves the bar entirely', () => {
  const events = [
    ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 1, effective_date: '2026-01-01' }),
    cashEv({ holding_id: 2, currency: 'USD', shares: 300, effective_date: '2026-01-05' }),
    cashEv({ holding_id: 2, currency: 'USD', shares: 0, action: 'delete', effective_date: '2026-01-07' }),
  ];
  const prices = [px(1, '2026-01-05', 100), px(1, '2026-01-06', 100), px(1, '2026-01-07', 100)];
  const res = monthlyAverageValues(events, prices, [], 'USD');
  // The closing snapshot replaces (not merges), so a spent balance can't linger.
  assert.equal(res.symbols.some(x => x.symbol === 'CASH:USD'), false);
  assert.equal(res.points[0].total, 100);
});

test('the monthly cash figure converts at the closing day\'s rate', () => {
  const events = [cashEv({ holding_id: 1, currency: 'KRW', shares: 1300000, effective_date: '2026-01-01' }),
    ev({ holding_id: 2, instrument_id: 1, symbol: 'A', shares: 0.0000001, effective_date: '2026-01-01' })];
  const prices = [px(1, '2026-01-05', 1), px(1, '2026-01-06', 1)];
  const fx = [{ date: '2026-01-05', fx: 1300 }, { date: '2026-01-06', fx: 1000 }];
  const res = monthlyAverageValues(events, prices, fx, 'USD');
  // Closing balance at the closing rate: 1,300,000 / 1000.
  assert.equal(Math.round(valOf(res, res.points[0], 'CASH:KRW')), 1300);
});

test('no cash events means the series is unchanged (securities only)', () => {
  const events = [ev({ holding_id: 1, instrument_id: 1, symbol: 'A', shares: 10, effective_date: '2026-01-01' })];
  const prices = [px(1, '2026-01-05', 100)];
  const res = dailyValues(events, prices, [], 'USD');
  assert.deepEqual(res.symbols.map(s => s.symbol), ['A']);
  assert.equal(res.points[0].total, 1000);
});

test('dailyValues: empty events yield no points', () => {
  assert.deepEqual(dailyValues([], [], [], 'USD'), { symbols: [], points: [] });
});
