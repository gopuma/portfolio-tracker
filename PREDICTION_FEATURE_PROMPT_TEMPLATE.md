# Prediction-Competition Feature — Build Prompt Template

> **How to use this:** Fill in every `«FILL IN: …»` placeholder below. Anything shown
> <u>underlined</u> is a guidance note from me explaining how to fill the template —
> delete those before you paste. Then send the whole completed document to the coding
> agent as a single build prompt. Section 0 is already filled from your real repo —
> verify it, don't rewrite it. The blanks are the decisions only you can make;
> everything else is pre-specified so the result is reproducible and leak-free.

---

## SECTION 0 — Project context <u>(pre-filled & verified — confirm, don't change)</u>

You are extending an existing app, **portfolio-tracker**, located at
`portfolio-tracker/`. Match its conventions exactly.

**Stack (do not introduce new frameworks without asking):**
- Backend: Node.js + Express, ES modules (`"type":"module"`), `mysql2` pool, `node-cron`, `yahoo-finance2`, `rss-parser`.
- DB: MySQL 8 (via `docker-compose.yml`).
- Frontend: React 18 + Vite, `react-router-dom`, `recharts`.

**Relevant existing files:**
- `backend/src/services/prediction.js` — current model `heuristic-v1`: a 4-factor ensemble (trend SMA20/50, momentum RSI14, 7-day sentiment, value z-score vs 200-day mean) → composite signal → 5-day price target. **Treat this as the first competitor; do not delete it.**
- `backend/src/services/stats.js`, `backend/src/services/mpt.js` — existing statistical helpers (reuse, don't duplicate).
- `backend/src/routes/predictions.js` — `GET /:symbol`, `POST /:symbol/recompute`.
- `backend/src/jobs/dailyPriceJob.js` — node-cron pattern to copy.
- `backend/src/migrations/00X_*.sql` — numbered, idempotent SQL migrations run by `npm run migrate`.

**Existing `predictions` table (already multi-model-ready):**
```
predictions(
  id, instrument_id, prediction_date, horizon_days, base_price,
  predicted_price, predicted_return, confidence, composite_signal,
  trend_signal, momentum_signal, sentiment_signal, value_signal,
  model_version VARCHAR(32) DEFAULT 'heuristic-v1', factors_json JSON, created_at,
  UNIQUE KEY (instrument_id, prediction_date, horizon_days, model_version)
)
```
Key implication: **the schema already supports many models × many horizons** via
`model_version` + `horizon_days`. The new work is (a) more models, (b) the 30-day
horizon, (c) an honest **backtest + evaluation harness**, and (d) a **leaderboard**.

Data available per instrument: `prices(trade_date, open/high/low/close_px, volume)`
and `sentiment_scores(score_date, score [-1,1], headline_count)`.

---

## SECTION 1 — Objective

«FILL IN: 2–4 sentences. What does "done" look like in your words? e.g. "Several
prediction methods each forecast every watchlist instrument at 5-day and 30-day
horizons daily; a nightly job scores matured predictions against realized prices;
a leaderboard page ranks methods by [metric] so I can see which method wins per
horizon." »

Each algorithm predicts 5 day or 30 day prediction on the stocks that I add. The result of prediction or accuracy of the prediction should be shown on the table.
I can sort the accuracy
---

## SECTION 2 — Execution environment decision <u>(READ — this is the biggest fork)</u>

Heavy ML (ARIMA/GARCH/gradient-boosting/LSTM) is awkward in pure Node. Choose one:

- **Option A — Pure Node/JS only.** Implement statistical + algorithmic models in JS
  (ARIMA-lite, ETS, linear/ridge regression, kNN are all feasible; deep learning is not).
  Pros: one stack, simplest deploy. Cons: limited ML.
- **Option B — Python sidecar microservice** added to the same `docker-compose.yml`
  (e.g. FastAPI + statsmodels/scikit-learn/xgboost). Node orchestrates and stores;
  Python only computes a forecast for a given series. Pros: real ML. Cons: 2nd service.

**My choice:** B Python sidecar microservice
**If B, allowed Python libs:** statsmodels, scikit-learn, xgboost, lightgbm
**Contract between Node and Python (if B):** Node POSTs a point-in-time price/feature
series + horizon; Python returns the standard prediction object from Section 4. Python
must be **stateless** and must never read the DB directly (prevents leakage).

---

## SECTION 3 — Model roster (the competitors)

<u>Every model gets a unique `model_version` string (also used as the leaderboard key).
Use the repeatable block below — copy it once per model. Aim for a spread across the
three families so the competition is meaningful. Suggestions in brackets; keep, cut, or add.</u>

**Horizons every model must produce:** 5 trading days **and** 30 trading days.

| # | model_version | family (stat / algo / ML) | one-line idea |
|---|---------------|---------------------------|---------------|
| 0 | `heuristic-v1` | algo | existing 4-factor ensemble (already built) |
| 1 | `naive-rw-v1`» | stat | «random-walk baseline: tomorrow = today» |
| 2 | `drift-v1`» | stat | «random walk + historical drift» |
| 3 | `arima-v1`» | stat | «ARIMA(p,d,q) on log prices» |
| 4 | `ets-v1`» | stat | «Holt-Winters / exponential smoothing» |
| 5 | `ridge-v1`» | ML | «ridge regression on TA features» |
| 6 | `gbm-v1`» | ML | «gradient boosting on TA + sentiment features» |
| 7 | `Monte Carlo simulation-v1`| ML | Monte Carlo Simulation over 10000 times |

> **Mandatory baseline:** include at least one naive random-walk model. A model that
> can't beat random-walk is not adding value — the leaderboard must expose that.

### Per-model spec block <u>(copy once per model)</u>
```
model_version: heuristic-v1
family: algo
horizons: [5, 30]
input features:  close, log-returns, SMA10/20/50, RSI14, 30d vol,
                 7d sentiment, volume z-score. List exactly; the agent builds these.»
training window: trailing 252 trading days, expanding, or fixed»
retrain cadence: weekly
hyperparameters: ARIMA order auto-selected by AIC; ridge alpha=…;
                  gbm n_estimators=…, max_depth=…, learning_rate=…»
random seed: 7
min history required: 60 closes; below this, skip & log»
notes: none
```

```
model_version: naive-rw-v1
family: stat
horizons: [5, 30]
input features:  close, log-returns, SMA10/20/50, RSI14, 30d vol,
                 7d sentiment, volume z-score. List exactly; the agent builds these.»
training window: trailing 252 trading days, expanding, or fixed»
retrain cadence: weekly
hyperparameters: ARIMA order auto-selected by AIC; ridge alpha=…;
                  gbm n_estimators=…, max_depth=…, learning_rate=…»
random seed: 7
min history required: 60 closes; below this, skip & log»
notes: none
```

```
model_version: arima-v1
family: «stat | algo | ML»
horizons: [5, 30]
input features:  close, log-returns, SMA10/20/50, RSI14, 30d vol,
                 7d sentiment, volume z-score. List exactly; the agent builds these.»
training window: trailing 252 trading days, expanding, or fixed»
retrain cadence: weekly
hyperparameters: ARIMA order auto-selected by AIC; ridge alpha=…;
                  gbm n_estimators=…, max_depth=…, learning_rate=…»
random seed: 7
min history required: 60 closes; below this, skip & log»
notes: none
```

```
model_version: drift-v1
family: stat 
horizons: [5, 30]
input features:  close, log-returns, SMA10/20/50, RSI14, 30d vol,
                 7d sentiment, volume z-score. List exactly; the agent builds these.»
training window: trailing 252 trading days, expanding, or fixed»
retrain cadence: weekly
hyperparameters: ARIMA order auto-selected by AIC; ridge alpha=…;
                  gbm n_estimators=…, max_depth=…, learning_rate=…»
random seed: 7
min history required: 60 closes; below this, skip & log»
notes: none
```

```
model_version: ets-v1
family: stat
horizons: [5, 30]
input features:  close, log-returns, SMA10/20/50, RSI14, 30d vol,
                 7d sentiment, volume z-score. List exactly; the agent builds these.»
training window: trailing 252 trading days, expanding, or fixed»
retrain cadence: weekly
hyperparameters: ARIMA order auto-selected by AIC; ridge alpha=…;
                  gbm n_estimators=…, max_depth=…, learning_rate=…»
random seed: 7
min history required: 60 closes; below this, skip & log»
notes: none
```

```
model_version: ridge-v1
family: «stat | algo | ML»
horizons: [5, 30]
input features:  close, log-returns, SMA10/20/50, RSI14, 30d vol,
                 7d sentiment, volume z-score. List exactly; the agent builds these.»
training window: trailing 252 trading days, expanding, or fixed»
retrain cadence: weekly
hyperparameters: ARIMA order auto-selected by AIC; ridge alpha=…;
                  gbm n_estimators=…, max_depth=…, learning_rate=…»
random seed: 7
min history required: 60 closes; below this, skip & log»
notes: none
```

```
model_version: gbm-v1
family: «stat | algo | ML»
horizons: [5, 30]
input features:  close, log-returns, SMA10/20/50, RSI14, 30d vol,
                 7d sentiment, volume z-score. List exactly; the agent builds these.»
training window: trailing 252 trading days, expanding, or fixed»
retrain cadence: weekly
hyperparameters: ARIMA order auto-selected by AIC; ridge alpha=…;
                  gbm n_estimators=…, max_depth=…, learning_rate=…»
random seed: 7
min history required: 60 closes; below this, skip & log»
notes: none
```

```
model_version: Monte Carlo simulation-v1`
family: «stat | algo | ML»
horizons: [5, 30]
input features:  close, log-returns, SMA10/20/50, RSI14, 30d vol,
                 7d sentiment, volume z-score. List exactly; the agent builds these.»
training window: trailing 252 trading days, expanding, or fixed»
retrain cadence: weekly
hyperparameters: ARIMA order auto-selected by AIC; ridge alpha=…;
                  gbm n_estimators=…, max_depth=…, learning_rate=…»
random seed: 7
min history required: 60 closes; below this, skip & log»
notes: none
```

```
model_version: 
family: «stat | algo | ML»
horizons: [5, 30]
input features:  close, log-returns, SMA10/20/50, RSI14, 30d vol,
                 7d sentiment, volume z-score. List exactly; the agent builds these.»
training window: trailing 252 trading days, expanding, or fixed»
retrain cadence: weekly
hyperparameters: ARIMA order auto-selected by AIC; ridge alpha=…;
                  gbm n_estimators=…, max_depth=…, learning_rate=…»
random seed: 7
min history required: 60 closes; below this, skip & log»
notes: none
```

---

## SECTION 4 — Standard prediction contract <u>(pre-filled — confirm)</u>

To compare models fairly, **every model, every horizon, returns the same object**,
and it is stored as one row in `predictions` (one row per instrument × date × horizon ×
model_version). Required fields:

```jsonc
{
  "model_version": "string",
  "horizon_days": 5,                 // or 30
  "prediction_date": "YYYY-MM-DD",   // the day the forecast is MADE (point-in-time)
  "base_price": 0.0,                 // last close known on prediction_date
  "predicted_price": 0.0,
  "predicted_return": 0.0,           // (predicted_price/base_price) - 1
  "direction": 1,                    // sign(predicted_return): +1 / 0 / -1
  "confidence": 0.0,                 // [0,1] — model's own confidence
  "pi_low": 0.0,                     // OPTIONAL 80% prediction-interval low
  "pi_high": 0.0,                    // OPTIONAL high
  "factors_json": { }                // model-specific internals for auditability
}
```
- **Target maturity date** = `prediction_date` + `horizon_days` *trading* days (not calendar).
- Store everything; never overwrite a past `prediction_date` row (needed for honest backtests).

---

## SECTION 5 — Data, point-in-time & anti-leakage rules <u>(pre-filled — confirm)</u>

These are non-negotiable for a trustworthy competition:
- **No look-ahead.** A prediction dated `D` may use data with `trade_date <= D` and
  `score_date <= D` ONLY. Walk forward; never let a model see its own target.
- **Walk-forward backtest**, not a single train/test split. For each historical date in
  the eval window, train on data up to that date, predict, then later score against the
  realized close at the maturity date.
- **Train/validation discipline:** hyperparameters tuned only on data before the eval
  window. The eval window is strictly out-of-sample.
- Min history to predict: «FILL IN, e.g. 60 closes». Missing-data policy: «FILL IN —
  forward-fill ≤ N gaps? skip instrument?».
- FX / Korean instruments: «FILL IN — predict in instrument's own currency, or KRW?
  Note: Korean ETFs may be proxied (your daily report scales them off US proxies).»
- Trading-day calendar source: «FILL IN — derive from existing `prices` rows, or a lib».

---

## SECTION 6 — Backtesting & evaluation harness (the heart of the competition)

Build a harness that, for a chosen window, produces a per-model × per-horizon scorecard.

**Eval window:** «FILL IN, e.g. last 180 trading days, rolling»
**Universe:** «FILL IN — all watchlist instruments? a subset?»

**Metrics to compute (pre-filled — keep the set, then pick the ranking metric below):**
- Directional accuracy (% of times sign of predicted_return matched realized).
- MAE and RMSE of predicted_return.
- MAPE of predicted_price.
- **RMSE skill score vs naive RW** = 1 − RMSE_model / RMSE_naive (>0 means beats baseline).
- Hit rate within prediction interval (if `pi_*` provided) — confidence calibration.
- Strategy back-check: realized return of "go long when direction=+1" vs buy-and-hold,
  plus its Sharpe — does acting on the signal pay?
- Coverage: how many predictions the model actually produced (penalize skips).

**Primary ranking metric:** «FILL IN — e.g. directional accuracy, or RMSE skill score»
**Tie-breakers (in order):** «FILL IN, e.g. RMSE skill score, then strategy Sharpe»
**Separate leaderboards per horizon (5d vs 30d): yes / «FILL IN»**
**Minimum sample size before a model is ranked:** «FILL IN, e.g. ≥ 30 matured predictions»

---

## SECTION 7 — New DB schema <u>(template migration — fill the blanks)</u>

Add a new numbered, idempotent migration `backend/src/migrations/00X_predictions_competition.sql`.
Reuse the existing `predictions` table for forecasts (it already has `model_version` +
`horizon_days`). Add:

```sql
-- Registry of competitors (metadata + enable/disable)
CREATE TABLE IF NOT EXISTS prediction_models (
  model_version VARCHAR(32) PRIMARY KEY,
  family        ENUM('stat','algo','ml') NOT NULL,
  display_name  VARCHAR(128) NOT NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  config_json   JSON,                      -- hyperparams, features, seed
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per matured prediction, with realized outcome + errors
CREATE TABLE IF NOT EXISTS prediction_evaluations (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  prediction_id   BIGINT NOT NULL,
  instrument_id   INT NOT NULL,
  model_version   VARCHAR(32) NOT NULL,
  horizon_days    INT NOT NULL,
  prediction_date DATE NOT NULL,
  maturity_date   DATE NOT NULL,
  base_price      DECIMAL(18,4) NOT NULL,
  predicted_price DECIMAL(18,4) NOT NULL,
  realized_price  DECIMAL(18,4) NOT NULL,
  predicted_return DECIMAL(10,6),
  realized_return  DECIMAL(10,6),
  abs_error       DECIMAL(10,6),           -- |pred_ret - real_ret|
  sq_error        DECIMAL(12,8),
  direction_hit   TINYINT(1),              -- 1 if signs matched
  in_interval     TINYINT(1),              -- realized within [pi_low, pi_high]
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_eval (prediction_id),
  CONSTRAINT fk_eval_pred FOREIGN KEY (prediction_id) REFERENCES predictions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Leaderboard: aggregate metrics per model × horizon over the eval window.
-- «FILL IN: implement as a VIEW computing the Section 6 metrics, or as a
--  materialized `model_scores` table refreshed by the nightly job. Pick one.»
```
«FILL IN: any extra columns you want stored (e.g. per-instrument breakdown table?).»

---

## SECTION 8 — API endpoints <u>(fill the list)</u>

Add to a router (extend `routes/predictions.js` or new `routes/competition.js`):
- `GET  /api/leaderboard?horizon=5|30&window=«FILL IN»` → ranked models + metrics.
- `GET  /api/predictions/:symbol?horizon=5|30` → latest forecast from every active model.
- `GET  /api/models` → registry from `prediction_models`.
- `POST /api/backtest` body `{ models?, horizon, window }` → run/refresh the harness. «confirm»
- «FILL IN: any others — e.g. per-model detail, per-instrument scorecard».

---

## SECTION 9 — Frontend <u>(fill the layout)</u>

A new route/page «FILL IN path, e.g. `/predictions`» with:
- A **leaderboard table**: columns = «FILL IN, suggested: rank, model, family,
  directional accuracy, RMSE skill, strategy Sharpe, # samples». Sortable by any column.
- A **horizon toggle** (5d / 30d) that re-queries the leaderboard.
- A per-symbol view overlaying each model's `predicted_price` vs actual on a `recharts`
  line chart (reuse existing chart components). «FILL IN: keep or cut».
- Visual cue when a model fails to beat the naive baseline (e.g. greyed row). «confirm».

---

## SECTION 10 — Scheduling / jobs <u>(fill the cadence)</u>

Follow the `jobs/dailyPriceJob.js` node-cron pattern. Order matters: predict only
**after** prices are updated.
- **Predict job** — for every active model × active instrument × {5,30}, generate &
  store a prediction. Runs at «FILL IN time/cron, after the price job».
- **Evaluation job** — find predictions whose maturity_date has passed and aren't yet
  in `prediction_evaluations`, fetch realized close, compute errors, insert. Then refresh
  the leaderboard. Runs «FILL IN cadence».
- Backfill: «FILL IN — should the agent backfill historical predictions across the eval
  window on first run so the leaderboard isn't empty? (recommended: yes)».

---

## SECTION 11 — Constraints, guardrails & definition of done

- **Reproducibility:** fixed seeds; same inputs → same outputs. Store config in `prediction_models.config_json`.
- **No look-ahead anywhere** (Section 5). Add at least one automated test that would fail if a model peeks at future data.
- **Versioning:** changing a model's logic ⇒ new `model_version` (e.g. `gbm-v2`); never silently mutate a ranked model.
- **Performance budget:** full daily predict run must finish under «FILL IN, e.g. 2 min»; backtest under «FILL IN».
- **Tests required:** «FILL IN — e.g. unit tests for each model's contract shape, a leakage test, a metrics-math test against a hand-computed example».
- **Don't break existing behavior:** `heuristic-v1`, current routes, and the daily price job must keep working.
- **Acceptance criteria (the agent must demonstrate these):**
  1. «FILL IN, e.g. `GET /api/leaderboard?horizon=5` returns ≥ N models with all metrics populated.»
  2. «FILL IN, e.g. naive-RW appears and at least one model beats it on RMSE skill.»
  3. «FILL IN, e.g. evaluation job correctly scores a known matured prediction.»
  4. «FILL IN.»

---

## SECTION 12 — Deliverables & out of scope

**Deliverables:** «FILL IN — migration(s), services, routes, jobs, frontend page, tests, a short README section, seed of `prediction_models`.»
**Explicitly OUT of scope:** «FILL IN — e.g. no auto-trading, no intraday, no new data vendors, no auth changes.»
**Build order I want:** «FILL IN — e.g. schema → contract+baselines → harness → 1 ML model → leaderboard API → frontend → remaining models.»

---

### Appendix — one fully-completed model block <u>(example to copy the style)</u>
```
model_version: naive-rw-v1
family: stat
horizons: [5, 30]
input features: close only
training window: none (uses last close)
retrain cadence: n/a
hyperparameters: none
random seed: 0
min history required: 1 close
notes: predicted_price = base_price (return 0); confidence fixed 0.5.
       This is the mandatory baseline every other model must beat.
```
