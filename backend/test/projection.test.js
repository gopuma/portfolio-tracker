/**
 * The projection's history: whole-month returns from a daily path, and today's mix held
 * at constant weights.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlyReturns, rebalancedReturns } from '../src/routes/projection.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('monthly returns run month end to month end and skip a month in progress', () => {
  const dates = ['2020-01-30', '2020-01-31', '2020-02-03', '2020-02-28', '2020-03-02', '2020-03-10'];
  const path = [0, 0.1, 0.05, 0.21, 0.3, 0.32];
  const m = monthlyReturns(dates, path);
  assert.deepEqual(m.map(x => x.month), ['2020-02']);
  assert.ok(close(m[0].r, 1.21 / 1.1 - 1));
  // A last date late in the month counts as that month's end.
  assert.deepEqual(monthlyReturns([...dates, '2020-03-27'], [...path, 0.331]).map(x => x.month), ['2020-02', '2020-03']);
});

test('rebalanced returns weight each holding by today\'s value every month', () => {
  const byKey = new Map([['A', [1, 1]], ['CASH:KRW', [0, 0]]]);
  // Buy-and-hold would let A's doubling lift its weight; constant weights keep it at 25%.
  assert.deepEqual(rebalancedReturns([{ key: 'A', value: 1 }, { key: 'CASH:KRW', value: 3 }], byKey), [0.25, 0.25]);
});
