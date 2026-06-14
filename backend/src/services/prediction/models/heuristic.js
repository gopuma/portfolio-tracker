/**
 * heuristic-v1 adapter — wraps the existing 4-factor ensemble (services/prediction.js)
 * into the competition's predict(ctx, horizon) contract, reusing computeHeuristic so
 * there is exactly one copy of that logic. This is the "first competitor" the template
 * refers to; the Overview page keeps using predictAndStore (5-day) unchanged.
 */
import { computeHeuristic } from '../../prediction.js';

export function predict(ctx, horizon) {
  const h = computeHeuristic(ctx.closes, ctx.sentAvg || 0, horizon);
  return {
    predicted_return: h.predicted_return,
    predicted_price: h.predicted_price,
    confidence: h.confidence,
    factors: h.factors,
  };
}
