/**
 * Every registered model must honor the standard prediction contract for both
 * horizons: a positive predicted_price, a finite predicted_return, and a confidence
 * in [0, 1]. Importing the registry is DB-free (the pool is created lazily and never
 * queried here).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, HORIZONS } from '../src/services/prediction/registry.js';

function makeSeries(n, seed = 3) {
  let a = seed >>> 0;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const out = [100];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * Math.exp((rnd() - 0.47) * 0.02));
  return out;
}

test('registry has the expected competitors', () => {
  const versions = MODELS.map(m => m.model_version).sort();
  assert.deepEqual(versions, [
    'arima-v1', 'drift-v1', 'ets-v1', 'gbm-lgbm-v1', 'gbm-v1',
    'heuristic-v1', 'montecarlo-v1', 'naive-rw-v1', 'ridge-v1',
  ]);
  // The mandatory baseline must exist.
  assert.ok(MODELS.some(m => m.model_version === 'naive-rw-v1'));
  // Remote (sidecar) models must declare their Python-side key.
  for (const m of MODELS.filter(x => x.remote)) {
    assert.ok(m.sidecarModel, `${m.model_version} missing sidecarModel`);
  }
});

test('each local model returns a valid prediction object for both horizons', () => {
  const closes = makeSeries(400);
  const ctx = { closes, sentAvg: 0.1 };
  // Remote models are exercised against the Python sidecar, not here.
  for (const m of MODELS.filter(x => !x.remote)) {
    for (const h of HORIZONS) {
      const out = m.predict(ctx, h, m.config);
      assert.ok(out && typeof out === 'object', `${m.model_version} returned nothing`);
      assert.ok(Number.isFinite(out.predicted_return), `${m.model_version} h=${h} bad return`);
      assert.ok(out.predicted_price > 0, `${m.model_version} h=${h} bad price`);
      assert.ok(out.confidence >= 0 && out.confidence <= 1, `${m.model_version} h=${h} conf out of range`);
    }
  }
});
