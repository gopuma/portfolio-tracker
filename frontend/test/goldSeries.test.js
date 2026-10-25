import test from 'node:test';
import assert from 'node:assert/strict';
import { rowsOf, intlKrwPerGram, mergeGold, averages, axisRange, GRAMS_PER_TROY_OZ } from '../src/goldSeries.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

test('rowsOf trims dates, sorts and drops bad rows', () => {
  const rows = rowsOf([
    { trade_date: '2026-01-03T00:00:00.000Z', close_px: '2' },
    { trade_date: '2026-01-02T00:00:00.000Z', close_px: 1 },
    { trade_date: '2026-01-04', close_px: null },
    { trade_date: null, close_px: 5 },
  ]);
  assert.deepEqual(rows, [{ t: '2026-01-02', v: 1 }, { t: '2026-01-03', v: 2 }]);
});

test('international gold is restated in KRW/g at each day\'s rate', () => {
  const intl = [{ t: '2026-01-02', v: 2000 }, { t: '2026-01-05', v: 2100 }];
  const fx = [{ t: '2026-01-02', v: 1300 }, { t: '2026-01-05', v: 1400 }];
  const out = intlKrwPerGram(intl, fx);
  assert.ok(close(out[0].v, (2000 * 1300) / GRAMS_PER_TROY_OZ));
  assert.ok(close(out[1].v, (2100 * 1400) / GRAMS_PER_TROY_OZ));
});

test('a day without a rate uses the latest earlier rate; days before any rate are dropped', () => {
  const intl = [{ t: '2026-01-01', v: 2000 }, { t: '2026-01-03', v: 2000 }];
  const fx = [{ t: '2026-01-02', v: 1300 }];
  const out = intlKrwPerGram(intl, fx);
  assert.equal(out.length, 1);
  assert.equal(out[0].t, '2026-01-03');
  assert.ok(close(out[0].v, (2000 * 1300) / GRAMS_PER_TROY_OZ));
});

test('premium is set only on days with both prices', () => {
  const krx = [{ t: '2026-01-02', v: 103 }, { t: '2026-01-03', v: 104 }];
  const intl = [{ t: '2026-01-02', v: 100 }, { t: '2026-01-04', v: 100 }];
  const out = mergeGold(krx, intl);
  assert.deepEqual(out.map(e => e.date), ['2026-01-02', '2026-01-03', '2026-01-04']);
  assert.ok(close(out[0].premium, 0.03));
  assert.deepEqual(out[0].above, [100, 103]);
  assert.deepEqual(out[0].below, [100, 100]);
  assert.equal(out[1].above, undefined);
  assert.equal(out[1].premium, undefined);
  assert.equal(out[2].premium, undefined);
  assert.deepEqual(mergeGold(krx, intl, '2026-01-03').map(e => e.date), ['2026-01-03', '2026-01-04']);
});

test('averages cover the last 1, 3 and 5 years', () => {
  const rows = [{ t: '2021-06-01', v: 10 }, { t: '2024-06-01', v: 20 }, { t: '2026-06-01', v: 30 }];
  const a = averages(rows, '2026-10-22');
  assert.equal(a.y1, 30);
  assert.equal(a.y3, 25);
  assert.equal(a.y5, 25);
  assert.equal(averages([], '2026-10-22').y1, null);
});

test('axisRange fits the data on round ticks', () => {
  const r = axisRange([172_000, 247_000, 200_000], { ticks: 8 });
  assert.deepEqual(r.domain, [170_000, 250_000]);
  assert.equal(r.ticks[1] - r.ticks[0], 10_000);
  assert.equal(r.clipped, 0);
});

test('axisRange can leave a spike outside and always keeps included values', () => {
  const values = Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.01 : -0.01));
  values.push(0.06);
  const r = axisRange(values, { ticks: 5, clip: 0.01, include: [0] });
  assert.ok(r.domain[0] <= -0.01 && r.domain[1] >= 0.01 && r.domain[1] < 0.06);
  assert.equal(r.clipped, 1);
  assert.ok(r.ticks.includes(0));
  assert.deepEqual(axisRange([]).domain, ['auto', 'auto']);
});

test('axisRange never asks for more than one tick over the target', () => {
  for (const [lo, hi] of [[-0.023, 0.024], [172_700, 247_000], [0.5, 0.51], [-3, 97]]) {
    const r = axisRange([lo, hi], { ticks: 7 });
    assert.ok(r.ticks.length <= 8, `${lo}..${hi}: ${r.ticks}`);
    assert.ok(r.domain[0] <= lo && r.domain[1] >= hi);
  }
});
