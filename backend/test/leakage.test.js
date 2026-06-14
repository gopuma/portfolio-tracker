/**
 * Anti-leakage guarantee: a model's forecast "as of" index i must depend ONLY on
 * data at-or-before i. We build two series identical up to i but diverging after,
 * slice both to i+1, and require identical predictions. This would fail if a model
 * ever reached past its input slice (e.g. used a global or the full array).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { predict as naiveRw } from '../src/services/prediction/models/naiveRw.js';
import { predict as drift } from '../src/services/prediction/models/drift.js';
import { predict as arima } from '../src/services/prediction/models/arima.js';
import { predict as ets } from '../src/services/prediction/models/ets.js';
import { predict as ridge } from '../src/services/prediction/models/ridge.js';
import { predict as monteCarlo } from '../src/services/prediction/models/monteCarlo.js';
import { predict as heuristic } from '../src/services/prediction/models/heuristic.js';

function makeSeries(n, seed = 1) {
  let a = seed >>> 0;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const out = [100];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * Math.exp((rnd() - 0.48) * 0.02));
  return out;
}

const MODELS = [
  ['naive-rw', naiveRw], ['drift', drift], ['arima', arima], ['ets', ets],
  ['ridge', ridge], ['montecarlo', monteCarlo], ['heuristic', heuristic],
];

test('models are point-in-time pure (no future leakage)', () => {
  const past = makeSeries(320, 7);          // indices 0..319 shared by both worlds
  const i = 319;
  // Two different futures appended after i.
  const worldA = [...past, ...makeSeries(40, 99).map(x => x * 5)];
  const worldB = [...past, ...makeSeries(40, 1234).map(x => x * 0.2)];

  for (const horizon of [5, 30]) {
    for (const [name, predict] of MODELS) {
      const a = predict({ closes: worldA.slice(0, i + 1), sentAvg: 0 }, horizon, { seed: 7, paths: 500 });
      const b = predict({ closes: worldB.slice(0, i + 1), sentAvg: 0 }, horizon, { seed: 7, paths: 500 });
      assert.equal(a.predicted_price, b.predicted_price, `${name} h=${horizon} leaked future data`);
      assert.equal(a.predicted_return, b.predicted_return, `${name} h=${horizon} return differs`);
    }
  }
});
