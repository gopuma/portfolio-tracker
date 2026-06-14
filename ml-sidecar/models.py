"""
Gradient-boosting forecasters (XGBoost & LightGBM).

Each model maps the same 8 TA features used by the JS ridge model to the h-step
cumulative log return, then exponentiates back to a price. Training is strictly
point-in-time: for an as-of index i we only use pairs (feature_row(closes, j),
log(closes[j+h]/closes[j])) with j+h <= i — never the future.

The service is stateless: it receives a price series and returns forecasts. It
never reads the database, so it cannot leak realized targets.
"""
from __future__ import annotations
import math
import numpy as np

from features import feature_row


def _r2(y_true, y_pred):
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    ss_tot = float(np.sum((y_true - y_true.mean()) ** 2))
    if ss_tot <= 0:
        return 0.0
    ss_res = float(np.sum((y_true - y_pred) ** 2))
    return max(0.0, min(1.0, 1 - ss_res / ss_tot))


def _clamp(x, lo, hi):
    return max(lo, min(hi, x))


def _build_estimator(model: str, config: dict):
    seed = int(config.get('seed', 7))
    n_estimators = int(config.get('n_estimators', 200))
    max_depth = int(config.get('max_depth', 3))
    lr = float(config.get('learning_rate', 0.05))
    subsample = float(config.get('subsample', 0.8))

    if model == 'xgboost':
        from xgboost import XGBRegressor
        return XGBRegressor(
            n_estimators=n_estimators, max_depth=max_depth, learning_rate=lr,
            subsample=subsample, colsample_bytree=0.9, reg_lambda=1.0,
            random_state=seed, n_jobs=1, verbosity=0, objective='reg:squarederror',
        )
    if model == 'lightgbm':
        from lightgbm import LGBMRegressor
        return LGBMRegressor(
            n_estimators=n_estimators, max_depth=max_depth, learning_rate=lr,
            subsample=subsample, colsample_bytree=0.9, reg_lambda=1.0,
            num_leaves=2 ** max_depth, random_state=seed, n_jobs=1, verbosity=-1,
        )
    raise ValueError(f'unknown model: {model}')


def _forecast_one(model, horizon, config, closes, i):
    """One point-in-time forecast at index i, trained only on data <= i."""
    sub = closes[: i + 1]
    base = sub[-1]
    train_window = int(config.get('train', 252))

    X, y = [], []
    start = max(50, i - horizon - train_window)
    for j in range(start, i - horizon + 1):
        f = feature_row(sub, j)
        if f is None:
            continue
        cj, cjh = sub[j], sub[j + horizon]
        if cj > 0 and cjh > 0:
            X.append(f)
            y.append(math.log(cjh / cj))
    f_pred = feature_row(sub, i)

    if len(X) < 40 or f_pred is None:
        mu = float(np.mean(y)) if y else 0.0          # fall back to mean drift
        pred = base * math.exp(mu)
        return {
            'as_of': i, 'predicted_return': pred / base - 1,
            'predicted_price': round(pred, 4), 'confidence': 0.4,
            'factors': {'fallback': 'mean-drift', 'n_train': len(X)},
        }

    est = _build_estimator(model, config)
    Xa, ya = np.asarray(X, dtype=float), np.asarray(y, dtype=float)
    est.fit(Xa, ya)
    r2 = _r2(ya, est.predict(Xa))                     # in-sample fit -> soft confidence
    pred_logret = float(est.predict(np.asarray([f_pred], dtype=float))[0])
    pred = base * math.exp(pred_logret)
    return {
        'as_of': i, 'predicted_return': pred / base - 1,
        'predicted_price': round(pred, 4),
        'confidence': round(_clamp(0.35 + 0.5 * r2, 0.05, 0.9), 4),
        'factors': {'model': model, 'n_train': len(X), 'r2_insample': round(r2, 4),
                    'n_estimators': int(config.get('n_estimators', 200))},
    }


def forecast(model, horizon, config, closes, as_of):
    """Forecast at each requested as-of index. Each is trained only on closes[0..i]."""
    return [_forecast_one(model, horizon, config, closes, int(i)) for i in as_of]
