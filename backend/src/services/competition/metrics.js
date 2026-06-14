/**
 * Pure metric math for the leaderboard. All functions operate on plain arrays of
 * evaluation records and have no DB or side effects, so they're unit-testable
 * against hand-computed fixtures.
 *
 * An evaluation record (the relevant subset) looks like:
 *   { predicted_return, realized_return, predicted_price, realized_price, direction_hit }
 */

export function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

export function stdevSample(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

/** % of predictions whose sign matched the realized move. */
export function directionalAccuracy(evals) {
  if (!evals.length) return null;
  return mean(evals.map(e => (e.direction_hit ? 1 : 0)));
}

export function maeReturn(evals) {
  if (!evals.length) return null;
  return mean(evals.map(e => Math.abs(e.predicted_return - e.realized_return)));
}

export function rmseReturn(evals) {
  if (!evals.length) return null;
  return Math.sqrt(mean(evals.map(e => (e.predicted_return - e.realized_return) ** 2)));
}

export function mapePrice(evals) {
  const valid = evals.filter(e => e.realized_price > 0);
  if (!valid.length) return null;
  return mean(valid.map(e => Math.abs(e.realized_price - e.predicted_price) / e.realized_price));
}

/** RMSE skill vs a baseline RMSE: 1 - rmse_model / rmse_naive. >0 beats baseline. */
export function rmseSkill(rmseModel, rmseNaive) {
  if (rmseModel == null || rmseNaive == null || rmseNaive === 0) return null;
  return 1 - rmseModel / rmseNaive;
}

/**
 * Strategy back-check: go long when predicted direction is up, short when down
 * (0 stays flat); the per-prediction realized payoff is sign(pred) * realized_return.
 * Returns { ret, sharpe } where ret is the mean payoff and sharpe = mean/stdev
 * (per-prediction, not annualized — comparable across models at the same horizon).
 */
export function strategy(evals) {
  if (!evals.length) return { ret: null, sharpe: null };
  const payoffs = evals.map(e => Math.sign(e.predicted_return) * e.realized_return);
  const m = mean(payoffs);
  const sd = stdevSample(payoffs);
  return { ret: m, sharpe: sd > 0 ? m / sd : null };
}

export function buyHoldReturn(evals) {
  if (!evals.length) return null;
  return mean(evals.map(e => e.realized_return));
}

/**
 * Full scorecard for one model × horizon. `naiveRmse` is the naive-rw RMSE for the
 * same horizon (for the skill score); pass null if unavailable.
 */
export function scorecard(evals, naiveRmse) {
  const rmse = rmseReturn(evals);
  const strat = strategy(evals);
  return {
    n_samples: evals.length,
    directional_accuracy: directionalAccuracy(evals),
    mae_return: maeReturn(evals),
    rmse_return: rmse,
    mape_price: mapePrice(evals),
    rmse_skill_vs_naive: rmseSkill(rmse, naiveRmse),
    strategy_return: strat.ret,
    strategy_sharpe: strat.sharpe,
    buyhold_return: buyHoldReturn(evals),
  };
}
