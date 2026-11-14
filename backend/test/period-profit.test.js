import test from 'node:test';
import assert from 'node:assert/strict';
import { periodProfit, dividendTaxRate, asOf, priceChecks, cashFlows, cashBalance, isStockPayAccount, tradePrice } from '../src/services/periodProfit.js';
import { dividendsFromEvents } from '../src/services/priceFetcher.js';

const series = obj => new Map(Object.entries(obj).map(([sym, pts]) => [sym, Object.entries(pts).map(([d, v]) => ({ d, v }))]));
// KRW per USD by date; null date = today's rate.
const usdKrw = { '2025-12-31': 1400, '2026-03-01': 1500, '2026-06-01': 1450 };
const krwPerUsd = d => (d == null ? 1300 : asOf(Object.entries(usdKrw).map(([k, v]) => ({ d: k, v })), d));
const toKrw = (amt, ccy, d) => (ccy === 'USD' ? amt * krwPerUsd(d) : amt);
const START = '2026-01-01', END = '2026-11-12';

test('asOf takes the last value on or before a date', () => {
  const s = [{ d: '2026-01-02', v: 1 }, { d: '2026-01-05', v: 2 }];
  assert.equal(asOf(s, '2026-01-01'), null);
  assert.equal(asOf(s, '2026-01-04'), 1);
  assert.equal(asOf(s, '2026-01-05'), 2);
  assert.equal(asOf(s, '2027-01-01'), 2);
});

test('withholding: none in IRP/ISA/pension accounts, 15.4% Korean, 15% foreign', () => {
  assert.equal(dividendTaxRate('KRW', '삼성증권 IRP'), 0);
  assert.equal(dividendTaxRate('KRW', '미래에셋증권 ISA'), 0);
  assert.equal(dividendTaxRate('KRW', '연금저축 삼성증권'), 0);
  assert.equal(dividendTaxRate('KRW', '영웅문'), 0.154);
  assert.equal(dividendTaxRate('USD', '영웅문'), 0.15);
});

test('a holding from before the year: price and exchange-rate change, no flows', () => {
  const r = periodProfit({
    txns: [{ symbol: 'X', account: '', side: 'buy', shares: 10, price: 50, currency: 'USD', trade_date: '2025-06-01' }],
    start: START, end: END,
    closes: series({ X: { '2025-12-31': 100 } }), dividends: new Map(), latest: new Map([['X', 110]]),
    toBase: toKrw,
  });
  assert.equal(r.start_value, 10 * 100 * 1400);
  assert.equal(r.end_value, 10 * 110 * 1300);
  assert.equal(r.profit, 1_430_000 - 1_400_000); // +10% in dollars, −7.1% from the won's rise
  assert.ok(Math.abs(r.return - 30_000 / 1_400_000) < 1e-12);
  assert.equal(r.invested, r.start_value);
});

test('a purchase in the year counts from its own date and price, not from Jan 1', () => {
  const r = periodProfit({
    txns: [{ symbol: 'K', account: '', side: 'buy', shares: 30, price: 338_500, currency: 'KRW', trade_date: '2026-06-01' }],
    start: START, end: END,
    closes: series({ K: { '2025-12-31': 103_000, '2026-06-01': 349_000 } }), dividends: new Map(),
    latest: new Map([['K', 206_000]]), toBase: toKrw,
  });
  assert.equal(r.start_value, 0);
  assert.equal(r.bought, 30 * 338_500);
  assert.equal(r.profit, 30 * (206_000 - 338_500));
  assert.ok(Math.abs(r.return - (206_000 / 338_500 - 1)) < 1e-12); // −39%, the stock's own loss
});

test('dividends count for shares held before the ex-date, after withholding', () => {
  const txns = [
    { symbol: 'D', account: '영웅문', side: 'buy', shares: 100, price: 10, currency: 'USD', trade_date: '2025-12-01' },
    { symbol: 'D', account: '영웅문', side: 'buy', shares: 100, price: 10, currency: 'USD', trade_date: '2026-03-01' },
  ];
  const r = periodProfit({
    txns, start: START, end: END,
    closes: series({ D: { '2025-12-31': 10 } }),
    // Ex on Mar 1: the shares bought that day don't qualify. Ex on Jun 1: all 200 do.
    dividends: series({ D: { '2026-03-01': 0.5, '2026-06-01': 0.5 } }),
    latest: new Map([['D', 10]]), toBase: toKrw,
  });
  const expected = (100 * 0.5 * 1500 + 200 * 0.5 * 1450) * 0.85;
  assert.ok(Math.abs(r.dividends - expected) < 1e-6);
  assert.ok(Math.abs(r.profit - (r.price_and_fx + expected)) < 1e-6);
});

test('cash rows are ignored and a holding with no price is reported', () => {
  const r = periodProfit({
    txns: [
      { symbol: 'CASH:KRW', account: 'KB', side: 'deposit', shares: 1e6, price: 1, currency: 'KRW', trade_date: '2025-01-01' },
      { symbol: 'Z', account: '', side: 'buy', shares: 1, price: 5, currency: 'KRW', trade_date: '2025-01-01' },
    ],
    start: START, end: END, closes: new Map(), dividends: new Map(), latest: new Map(), toBase: toKrw,
  });
  assert.deepEqual(r.missing, ['Z']);
  assert.equal(r.start_value, 0);
  assert.equal(r.end_value, 0);
});

test("Yahoo dividend events become ex-dates in the exchange's timezone", () => {
  // 2025-12-10 14:30 UTC (New York open) and a Seoul event at 00:00 UTC = 09:00 KST.
  const ny = dividendsFromEvents({ dividends: [{ amount: 0.278, date: new Date('2025-12-10T14:30:00Z') }] }, 'America/New_York');
  assert.deepEqual(ny, [{ ex_date: '2025-12-10', amount: 0.278 }]);
  // Raw payload shape (validateResult:false): an object keyed by timestamp, dates in seconds.
  const kr = dividendsFromEvents({ dividends: { 1763164800: { amount: 21, date: 1763164800 } } }, 'Asia/Seoul');
  assert.deepEqual(kr, [{ ex_date: '2025-11-15', amount: 21 }]);
  assert.deepEqual(dividendsFromEvents(undefined, 'UTC'), []);
  assert.deepEqual(dividendsFromEvents({ dividends: [{ amount: 0, date: new Date() }] }, 'UTC'), []);
});

test('a trade priced outside its day\'s range is an average cost: counted at the close', () => {
  const bars = new Map([
    ['MU', [{ d: '2025-12-31', v: 285.41, lo: 284.18, hi: 293.17 }]],
    ['OK', [{ d: '2026-03-02', v: 100, lo: 98, hi: 103 }]],
    ['NR', [{ d: '2026-03-02', v: 100 }]], // no low/high: 5% from the close decides
  ]);
  const t = (symbol, price, trade_date = '2026-03-02') => ({ symbol, side: 'buy', shares: 1, price, currency: 'USD', trade_date });
  assert.deepEqual(
    [t('MU', 959.48, '2026-01-01'), t('OK', 102.9), t('OK', 103.4), t('OK', 110), t('NR', 104), t('NR', 106), t('NEW', 135)]
      .map(x => { const r = tradePrice(x, bars); return [r.status, r.price]; }),
    [['average', 285.41], ['ok', 102.9], ['ok', 103.4], ['average', 100], ['ok', 104], ['average', 100], ['no_price', 135]],
  );
});

test('price checks list the trades not counted at their recorded price, with account and day range', () => {
  const txns = [
    { symbol: 'MU', account: '영웅문', side: 'buy', shares: 30, price: 959.48, currency: 'USD', trade_date: '2026-01-01' },
    { symbol: 'OK', side: 'buy', shares: 1, price: 101, currency: 'USD', trade_date: '2026-03-02' },
    { symbol: 'NEW', side: 'buy', shares: 1, price: 135, currency: 'USD', trade_date: '2026-01-01' },
    { symbol: 'OLD', side: 'buy', shares: 1, price: 999, currency: 'USD', trade_date: '2025-06-01' },
    { symbol: 'CASH:USD', side: 'deposit', shares: 5, price: 1, currency: 'USD', trade_date: '2026-02-01' },
  ];
  const bars = new Map([
    ['MU', [{ d: '2025-12-31', v: 285.41, lo: 284.18, hi: 293.17 }]],
    ['OK', [{ d: '2026-03-02', v: 100, lo: 98, hi: 103 }]],
    ['OLD', [{ d: '2025-06-01', v: 10, lo: 9, hi: 11 }]],
  ]);
  const flagged = priceChecks(txns, START, END, bars);
  assert.deepEqual(flagged.map(f => [f.symbol, f.status, f.account, f.counted_at]), [['MU', 'average', '영웅문', 285.41], ['NEW', 'no_price', '', 135]]);
  assert.equal(flagged[0].low, 284.18);
  assert.equal(flagged[0].high, 293.17);
});

test('an average-cost buy counts as money put in at that day\'s close, so it adds no false loss', () => {
  const bars = new Map([['MU', [{ d: '2025-12-31', v: 285.41, lo: 284.18, hi: 293.17 }]]]);
  const r = periodProfit({
    txns: [{ symbol: 'MU', account: '', side: 'buy', shares: 30, price: 959.48, currency: 'USD', trade_date: '2026-01-01' }],
    start: START, end: END, closes: bars, dividends: new Map(), latest: new Map([['MU', 798.44]]), toBase: (a) => a,
  });
  assert.ok(Math.abs(r.bought - 30 * 285.41) < 1e-9);
  assert.ok(Math.abs(r.profit - 30 * (798.44 - 285.41)) < 1e-9);
});

test('cash flows sum deposits and withdrawals in the period at each date\'s rate', () => {
  const txns = [
    { symbol: 'CASH:USD', side: 'deposit', shares: 100, price: 1, currency: 'USD', trade_date: '2026-03-01' },
    { symbol: 'CASH:KRW', side: 'withdraw', shares: 50_000, price: 1, currency: 'KRW', trade_date: '2026-06-01' },
    { symbol: 'CASH:KRW', side: 'deposit', shares: 9e9, price: 1, currency: 'KRW', trade_date: '2025-01-01' },
  ];
  assert.deepEqual(cashFlows(txns, START, END, toKrw), { deposits: 150_000, withdrawals: 50_000 });
});

test('a past period ends with the holdings of its last day, not later trades', () => {
  const r = periodProfit({
    txns: [
      { symbol: 'X', account: '', side: 'buy', shares: 10, price: 100, currency: 'KRW', trade_date: '2025-03-01' },
      { symbol: 'X', account: '', side: 'buy', shares: 90, price: 100, currency: 'KRW', trade_date: '2026-02-05' },
    ],
    start: '2025-01-01', end: '2025-12-31',
    closes: series({ X: { '2025-03-01': 100 } }), dividends: new Map(), latest: new Map([['X', 120]]), toBase: toKrw,
  });
  assert.equal(r.end_value, 10 * 120);
  assert.equal(r.profit, 200);
});

test('cash balance at a date: deposits less withdrawals so far, at the end rate', () => {
  const txns = [
    { symbol: 'CASH:KRW', side: 'deposit', shares: 1_000_000, price: 1, currency: 'KRW', trade_date: '2024-01-01' },
    { symbol: 'CASH:KRW', side: 'withdraw', shares: 400_000, price: 1, currency: 'KRW', trade_date: '2026-02-05' },
    { symbol: 'CASH:USD', side: 'deposit', shares: 100, price: 1, currency: 'USD', trade_date: '2025-06-01' },
    { symbol: 'X', side: 'buy', shares: 1, price: 999, currency: 'USD', trade_date: '2025-06-01' },
  ];
  assert.equal(cashBalance(txns, '2025-12-31', toKrw), 1_000_000 + 100 * 1300);
  assert.equal(cashBalance(txns, '2026-11-12', toKrw), 600_000 + 100 * 1300);
  assert.equal(cashBalance(txns, '2023-12-31', toKrw), 0);
});

test('stock plan accounts are recognised by name', () => {
  assert.equal(isStockPayAccount('Morgan Stanley'), true);
  assert.equal(isStockPayAccount('E*TRADE'), true);
  assert.equal(isStockPayAccount('Fidelity Stock Plan'), true);
  assert.equal(isStockPayAccount('영웅문'), false);
  assert.equal(isStockPayAccount(''), false);
});
