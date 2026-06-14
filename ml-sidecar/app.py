"""
Stateless ML sidecar for the prediction competition.

Node POSTs a point-in-time close series + horizon + a list of as-of indices; this
service trains a gradient-boosting model (XGBoost or LightGBM) for each as-of point
using only data at-or-before that point, and returns the standard prediction object.
It never touches the database — that's what prevents look-ahead leakage.
"""
from __future__ import annotations
from typing import List, Dict, Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from models import forecast

app = FastAPI(title="portfolio-tracker ML sidecar", version="1.0.0")

SUPPORTED = {"xgboost", "lightgbm"}


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
