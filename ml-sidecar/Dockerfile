# ML sidecar: FastAPI + XGBoost/LightGBM. Stateless; computes forecasts only.
FROM python:3.11-slim

# libgomp1 is required by both xgboost and lightgbm (OpenMP runtime).
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
