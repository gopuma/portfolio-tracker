/**
 * The projection's Monte Carlo engine: with volatility and inflation switched off every
 * path is the same, so results can be checked against simple arithmetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, historyStats, monthlyLogParams, combineHistory, MIN_PATHS } from '../src/projection/simulate.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const flat = { start: 100, years: 20, paths: MIN_PATHS, seed: 7, model: 'normal', mean: 0, vol: 0, inflation: 0, inflationVol: 0, strategy: 'fixed', spending: 0, income: 0, incomeStart: 0 };

test('at least 10,000 paths always run', () => {
  assert.equal(simulate({ ...flat, paths: 50 }).paths, MIN_PATHS);
});

test('no growth, fixed spending: money lasts start ÷ spending years', () => {
  const r = simulate({ ...flat, spending: 10 });
  assert.ok(close(r.real[5].p50, 50));
  assert.equal(r.real[20].p50, 0);
  assert.equal(r.success, 0);
  assert.ok(close(r.firstRunOut.p50, 10, 0.02));
  // The most that lasts 20 years is 100 / 20.
  assert.ok(close(r.safeSpending.lasts90, 5));
  // Keeping the full 100 leaves nothing to spend.
  assert.ok(close(r.safeSpending.keeps90, 0));
});

test('the most that lasts really does last', () => {
  const base = { ...flat, mean: 0.05, vol: 0, years: 30 };
  const s = simulate({ ...base, spending: 1 }).safeSpending.lasts90;
  assert.equal(simulate({ ...base, spending: s * 0.999 }).success, 1);
  assert.equal(simulate({ ...base, spending: s * 1.01 }).success, 0);
});

test('growth compounds at the chosen average return when there is no volatility', () => {
  const r = simulate({ ...flat, mean: 0.06, years: 10 });
  assert.ok(close(r.nominal[10].p50, 100 * 1.06 ** 10, 1e-5));
});

test('inflation: today\'s-money value deflates the future balance; spending rises with it', () => {
  // Return equals inflation, so the real balance only falls by the real spending.
  const r = simulate({ ...flat, mean: 0.03, inflation: 0.03, spending: 0, years: 10 });
  assert.ok(close(r.real[10].p50, 100, 1e-5));
  assert.ok(close(r.nominal[10].p50, 100 * 1.03 ** 10, 1e-5));
});

test('income from a later year reduces what is drawn', () => {
  const r = simulate({ ...flat, spending: 10, income: 10, incomeStart: 5 });
  assert.ok(close(r.real[20].p50, 50));
  assert.equal(r.success, 1);
});

test('percent-of-balance spending never runs out and shrinks with the balance', () => {
  const r = simulate({ ...flat, strategy: 'percent', rate: 0.04, years: 10 });
  assert.equal(r.success, 1);
  assert.ok(close(r.real[10].p50, 100 * 0.96 ** 10, 1e-5));
  assert.ok(close(r.spending[1].p50, 100 * 0.96 * 0.04, 1e-5));
});

test('volatility spreads the outcomes; the median falls below the mean', () => {
  const r = simulate({ ...flat, mean: 0.07, vol: 0.15, years: 30 });
  assert.ok(r.real[30].p5 < r.real[30].p50 && r.real[30].p50 < r.real[30].p95);
  assert.ok(r.real[30].p50 < 100 * 1.07 ** 30);
});

test('history stats round-trip through the model parameters', () => {
  const hist = Array.from({ length: 240 }, (_, i) => (i % 2 ? 0.04 : -0.025));
  const st = historyStats(hist);
  const { m, s } = monthlyLogParams(st.mean, st.vol);
  const logs = hist.map(r => Math.log(1 + r));
  const hm = logs.reduce((a, b) => a + b, 0) / logs.length;
  assert.ok(close(m, hm, 1e-9));
  assert.ok(close(s, Math.sqrt(logs.reduce((a, x) => a + (x - hm) ** 2, 0) / (logs.length - 1)), 1e-9));
});

test('historical blocks rescaled to the chosen return reach about that return', () => {
  const hist = Array.from({ length: 300 }, (_, i) => Math.sin(i * 1.7) * 0.05 + 0.004);
  const r = simulate({ ...flat, model: 'historical', history: hist, mean: 0.05, vol: 0.12, years: 20 });
  const target = monthlyLogParams(0.05, 0.12);
  const medianGrowth = Math.log(r.nominal[20].p50 / 100) / 240;
  assert.ok(Math.abs(medianGrowth - target.m) < 0.0005);
});

test('cash earns inflation plus its margin; the invested part earns the chosen return', () => {
  // All cash at inflation + 0.5%: the real balance grows 0.5% a year.
  const r = simulate({ ...flat, inflation: 0.03, cashShare: 1, cashSpread: 0.005, mean: 0.5, years: 10 });
  assert.ok(close(r.real[10].p50, 100 * 1.005 ** 10, 1e-5));
  // Half cash at 0% real, half invested at 6% with inflation off: monthly rebalanced blend.
  const g = 0.5 + 0.5 * Math.pow(1.06, 1 / 12);
  const h = simulate({ ...flat, cashShare: 0.5, mean: 0.06, years: 10 });
  assert.ok(close(h.real[10].p50, 100 * g ** 120, 1e-5));
});

test('other assets earn their steady rate alongside cash and investments', () => {
  // A quarter at 5%, the rest in cash at 0% real with inflation off.
  const r = simulate({ ...flat, cashShare: 0.75, otherShare: 0.25, otherRate: 0.05, years: 10 });
  const g = 0.75 + 0.25 * Math.pow(1.05, 1 / 12);
  assert.ok(close(r.real[10].p50, 100 * g ** 120, 1e-5));
});

test('combined history is value-weighted', () => {
  const c = combineHistory([[0.1, 0], [0, 0.2]], [3, 1]);
  assert.ok(close(c[0], 0.075) && close(c[1], 0.05));
});
