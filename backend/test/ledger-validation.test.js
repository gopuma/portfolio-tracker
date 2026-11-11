/**
 * Ledger write safety: the chronological oversell invariant, and the input validators that
 * keep malformed dates and out-of-range numbers from reaching MySQL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findOversell } from '../src/services/ledgerService.js';
import { parseTradeDate, parseShares, parsePrice, parseId, parseAccount, HttpError } from '../src/validation.js';

const tx = (id, side, symbol, shares, trade_date, account = '') => ({ id, side, symbol, shares, price: 10, account, trade_date });

test('findOversell: a balanced ledger passes', () => {
  const txns = [tx(1, 'buy', 'A', 10, '2026-01-01'), tx(2, 'sell', 'A', 10, '2026-02-01')];
  assert.equal(findOversell(txns), null);
});

test('findOversell: catches a lot that goes short mid-history even when it ends positive', () => {
  // Sell back-dated ahead of the buy that funds it: final balance is +5, but it is -5 on 01-01.
  const txns = [
    tx(1, 'sell', 'A', 5, '2026-01-01'),
    tx(2, 'buy', 'A', 10, '2026-02-01'),
  ];
  assert.deepEqual(findOversell(txns), { symbol: 'A', account: '', trade_date: '2026-01-01', shares: -5 });
});

test('findOversell: deleting the funding buy leaves the later sell short', () => {
  const full = [tx(1, 'buy', 'A', 10, '2026-01-01'), tx(2, 'buy', 'A', 5, '2026-02-01'), tx(3, 'sell', 'A', 12, '2026-03-01')];
  assert.equal(findOversell(full), null);
  const withoutFirstBuy = full.filter(t => t.id !== 1);
  assert.equal(findOversell(withoutFirstBuy)?.trade_date, '2026-03-01');
});

test('findOversell: lots are per (symbol, account) and cash may go negative', () => {
  const txns = [
    tx(1, 'buy', 'A', 10, '2026-01-01', 'ISA'),
    tx(2, 'sell', 'A', 5, '2026-01-02', 'Brokerage'), // different account: no shares there
    tx(3, 'withdraw', 'CASH:USD', 1000, '2026-01-03'),
  ];
  assert.deepEqual(findOversell(txns), { symbol: 'A', account: 'Brokerage', trade_date: '2026-01-02', shares: -5 });
  assert.equal(findOversell([tx(1, 'withdraw', 'CASH:USD', 1000, '2026-01-03')]), null);
});

const rejects400 = (fn, re) => assert.throws(fn, e => e instanceof HttpError && e.status === 400 && (!re || re.test(e.message)));

test('parseTradeDate: accepts a real past date and applies the fallback', () => {
  assert.equal(parseTradeDate('2026-02-28', { today: '2026-09-15' }), '2026-02-28');
  assert.equal(parseTradeDate('', { fallback: '2026-09-15' }), '2026-09-15');
  assert.equal(parseTradeDate(undefined, { fallback: '2026-09-15' }), '2026-09-15');
});

test('parseTradeDate: rejects garbage, impossible, future, and missing-required dates', () => {
  const today = '2026-09-15';
  rejects400(() => parseTradeDate('abc', { today }), /YYYY-MM-DD/);
  rejects400(() => parseTradeDate('2026-09-15T00:00', { today }), /YYYY-MM-DD/); // no silent truncation
  rejects400(() => parseTradeDate('2026-02-30', { today }), /real calendar date/);
  rejects400(() => parseTradeDate('2026-13-01', { today }), /real calendar date/);
  rejects400(() => parseTradeDate('2026-09-16', { today }), /future/);
  rejects400(() => parseTradeDate('1969-12-31', { today }), /on or after/);
  rejects400(() => parseTradeDate('', { today }), /required/);
});

test('parseShares / parsePrice: bounds follow the DECIMAL columns', () => {
  assert.equal(parseShares('12.5'), 12.5);
  assert.equal(parseShares('0.00000001'), 1e-8); // one satoshi: DECIMAL(26,8)
  rejects400(() => parseShares(0.000000001), /at least/); // would round to 0
  assert.equal(parseShares(0, 'shares', { allowZero: true }), 0);
  rejects400(() => parseShares(0));
  rejects400(() => parseShares(-1));
  rejects400(() => parseShares(1e30), /at most/);
  rejects400(() => parseShares('1e30'), /at most/);
  rejects400(() => parseShares('abc'));
  rejects400(() => parseShares(''));
  rejects400(() => parseShares(true)); // Number(true) === 1 must not slip through
  rejects400(() => parseShares([5]));
  rejects400(() => parseShares(Infinity));
  rejects400(() => parsePrice(0.00001), /at least/); // would round to 0 in DECIMAL(18,4)
  rejects400(() => parsePrice(1e14), /at most/);
  assert.equal(parsePrice('113.625'), 113.625);
});

test('parseId: only plain positive integers; anything else is a 404', () => {
  assert.equal(parseId('42', 'Portfolio'), 42);
  for (const bad of ['0', '12abc', '-1', '1.5', '', ' 7', '0x10']) {
    assert.throws(() => parseId(bad, 'Portfolio'), e => e.status === 404 && e.message === 'Portfolio not found');
  }
});

test('parseAccount: trims, caps at the column width, rejects non-strings', () => {
  assert.equal(parseAccount('  ISA  '), 'ISA');
  assert.equal(parseAccount(undefined), '');
  assert.equal(parseAccount('x'.repeat(100)).length, 64);
  rejects400(() => parseAccount({ a: 1 }));
});
