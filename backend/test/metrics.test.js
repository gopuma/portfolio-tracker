/**
 * Metric math, checked against hand-computed values so a refactor can't silently
 * change how the leaderboard is scored.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  directionalAccuracy, rmseReturn, maeReturn, rmseSkill, scorecard,
} from '../src/services/competition/metrics.js';

// 4 predictions: 3 direction-correct, errors of +0.01, -0.02, +0.00, -0.04.
const evals = [
  { predicted_return: 0.03, realized_return: 0.02, predicted_price: 103, realized_price: 102, direction_hit: 1 },
  { predicted_return: 0.00, realized_return: 0.02, predicted_price: 100, realized_price: 102, direction_hit: 1 },
  { predicted_return: -0.01, realized_return: -0.01, predicted_price: 99, realized_price: 99, direction_hit: 1 },
  { predicted_return: 0.02, realized_return: -0.02, predicted_price: 102, realized_price: 98, direction_hit: 0 },
];

test('directional accuracy', () => {
  assert.equal(directionalAccuracy(evals), 3 / 4);
});

test('MAE of return', () => {
  // |0.01| + |-0.02| + |0| + |0.04| = 0.07; /4 = 0.0175
  assert.ok(Math.abs(maeReturn(evals) - 0.0175) < 1e-9);
});

test('RMSE of return', () => {
  // sq errors: 0.0001, 0.0004, 0, 0.0016 -> mean 0.000525 -> sqrt
  const expected = Math.sqrt((0.0001 + 0.0004 + 0 + 0.0016) / 4);
  assert.ok(Math.abs(rmseReturn(evals) - expected) < 1e-12);
});

test('RMSE skill vs naive', () => {
  assert.equal(rmseSkill(0.8, 1.0), 1 - 0.8);     // model better -> +0.2
  assert.equal(rmseSkill(1.2, 1.0), 1 - 1.2);     // worse -> -0.2
  assert.equal(rmseSkill(1.0, 0), null);          // guard against /0
});

test('scorecard wires the pieces together', () => {
  const s = scorecard(evals, 0.05);
  assert.equal(s.n_samples, 4);
  assert.equal(s.directional_accuracy, 0.75);
  assert.ok(s.rmse_return > 0);
  assert.equal(s.rmse_skill_vs_naive, 1 - s.rmse_return / 0.05);
});

test('empty input is null-safe', () => {
  assert.equal(directionalAccuracy([]), null);
  assert.equal(rmseReturn([]), null);
});
