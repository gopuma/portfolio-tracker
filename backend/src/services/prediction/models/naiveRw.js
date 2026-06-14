/**
 * naive-rw-v1 — random-walk baseline. Tomorrow = today, so the h-step forecast is
 * just the last close (predicted_return = 0). This is the mandatory baseline every
 * other model must beat; the leaderboard's RMSE skill score is measured against it.
 */
export function predict(ctx /* , horizon */) {
  const base = ctx.closes[ctx.closes.length - 1];
  return {
    predicted_return: 0,
    predicted_price: +base.toFixed(4),
    confidence: 0.5,
    factors: { method: 'random-walk' },
  };
}
