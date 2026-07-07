"""
Stateless ML sidecar for the prediction competition.

Node POSTs a point-in-time close series + horizon + a list of as-of indices; this
service trains a gradient-boosting model (XGBoost or LightGBM) for each as-of point
using only data at-or-before that point, and returns the standard prediction object.
It never touches the database — that's what prevents look-ahead leakage.
"""
from __future__ import annotations
from statistics import median
from typing import List, Dict, Any, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from models import forecast

app = FastAPI(title="portfolio-tracker ML sidecar", version="1.0.0")

SUPPORTED = {"xgboost", "lightgbm"}


def _next_quarter(series: List[Optional[float]]) -> Optional[float]:
    """Seasonal-naive next-quarter forecast for a quarterly fundamentals series
    (oldest→newest). Uses the same quarter a year ago scaled by the median YoY growth;
    falls back to a QoQ drift when there isn't a full year of history. This is a simple
    'house view' to compare against analyst consensus, not a high-accuracy forecaster."""
    n = len(series)
    if n == 0:
        return None
    yoy = [series[i] / series[i - 4] for i in range(4, n)
           if series[i] is not None and series[i - 4] not in (None, 0)]
    if n >= 5 and series[n - 4] not in (None, 0) and yoy:
        return series[n - 4] * median(yoy)
    qoq = [series[i] / series[i - 1] for i in range(1, n)
           if series[i] is not None and series[i - 1] not in (None, 0)]
    last = next((x for x in reversed(series) if x is not None), None)
    if qoq and last is not None:
        return last * median(qoq)
    return last


class ForecastRequest(BaseModel):
    model: str
    horizon: int
    closes: List[float]
    as_of: List[int]
    config: Dict[str, Any] = {}


@app.get("/health")
def health():
    return {"ok": True, "models": sorted(SUPPORTED)}


@app.post("/forecast")
def do_forecast(req: ForecastRequest):
    if req.model not in SUPPORTED:
        raise HTTPException(status_code=400, detail=f"unknown model {req.model}")
    if req.horizon <= 0:
        raise HTTPException(status_code=400, detail="horizon must be positive")
    if not req.closes:
        raise HTTPException(status_code=400, detail="closes is empty")
    preds = forecast(req.model, req.horizon, req.config, req.closes, req.as_of)
    return {"model": req.model, "horizon": req.horizon, "count": len(preds), "predictions": preds}


class FundamentalsRequest(BaseModel):
    # Quarterly series in the company's native currency, oldest → newest.
    revenue: List[Optional[float]] = []
    eps: List[Optional[float]] = []


@app.post("/fundamentals/forecast")
def do_fundamentals_forecast(req: FundamentalsRequest):
    """Next-quarter revenue & EPS forecast (seasonal-naive) as a supplement to consensus."""
    return {"revenue": _next_quarter(req.revenue), "eps": _next_quarter(req.eps)}
