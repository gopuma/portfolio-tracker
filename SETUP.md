# Running Portfolio Tracker — Detailed Setup Guide

This walks you through running the app from a fresh clone, step by step, on macOS,
Linux, or Windows. If you just want the short version, see the Quick Start in
[README.md](README.md).

---

## 1. What you're running (architecture)

Three processes work together:

```
┌────────────────────────┐         ┌──────────────────────────────┐
│  Frontend (Vite/React) │  /api   │  Backend (Node/Express)      │
│  http://localhost:5173 │ ──────► │  http://localhost:4000       │
└────────────────────────┘  proxy  └──────────────┬───────────────┘
                                                   │
                          ┌────────────────────────┼────────────────────────┐
                          ▼                                                  ▼
                ┌───────────────────┐                          ┌──────────────────────────┐
                │ MySQL (container) │                          │  ML sidecar (container)   │
                │  localhost:3306   │                          │  localhost:8008  (FastAPI)│
                └───────────────────┘                          └──────────────────────────┘
```

- **MySQL** and the **ML sidecar** run as **containers** (via Colima's Docker-compatible engine).
- The **backend** and **frontend** run **directly on your machine** with Node.
- The frontend dev server proxies `/api` to the backend, so you don't configure any
  API URL for local development.

---

## 2. Prerequisites

Install these first:

| Tool | Version | Check | Notes |
|------|---------|-------|-------|
| **Colima** + **Docker CLI** | current | `colima version` · `docker --version` | Lightweight container runtime for MySQL + the ML sidecar (replaces Docker Desktop). Install with `brew install colima docker docker-compose`. Windows users can use Docker Desktop (WSL2) or Podman instead. |
| **Node.js** | **20 LTS or newer** (18.11+ minimum) | `node --version` | The backend uses `node --watch`, which needs ≥18.11. |
| **Git** | any | `git --version` | To clone. |

> **Colima** provides a Docker-compatible engine, so the standard `docker` / `docker compose`
> commands below work unchanged — no Docker Desktop required. Start it once per session with
> `colima start` (see step 5).
>
> The ML sidecar's Python/XGBoost/LightGBM all live **inside its container image** — you do
> **not** need Python installed on your machine.

---

## 3. Clone

```bash
git clone https://github.com/gopuma/portfolio-tracker.git
cd portfolio-tracker
```

---

## 4. Environment variables (optional for local dev)

**You can skip this for a default local run** — the code defaults match the Compose
defaults, so it works out of the box.

Only create a `.env` if you want to change credentials/ports:

```bash
cp .env.example .env      # macOS/Linux
# Windows (PowerShell):  Copy-Item .env.example .env
```

Then edit values as needed. Note on placement if you customize:
- `docker-compose.yml` reads `.env` from the **project root** (for DB user/password/ports
  and `ML_SIDECAR_PORT`).
- The backend reads its env from the **`backend/` directory** when you run its npm scripts
  (`dotenv` loads from the current working directory). If you change DB credentials, put a
  matching `.env` in `backend/` too (or export the vars in your shell).

Default credentials (used if you skip `.env`): DB `portfolio` / user `portfolio` /
password `portfoliopass` on `127.0.0.1:3306`; sidecar on `http://localhost:8008`.

---

## 5. Start the container services (MySQL + ML sidecar)

First start the Colima runtime (once per login session — it boots a small VM):

```bash
colima start                 # add e.g. --cpu 2 --memory 4 to tune resources
```

Then bring up the services with the usual Compose command:

```bash
docker compose up -d mysql ml-sidecar
```

- The **first run builds the ML sidecar image** (installs XGBoost/LightGBM) — this takes a
  few minutes. Subsequent starts are instant.
- Verify both are healthy:

```bash
docker compose ps
curl http://localhost:8008/health      # -> {"ok":true,"models":["lightgbm","xgboost"]}
```

> **Port already in use?** If `8008` (sidecar) or `3306` (MySQL) is taken, set a different
> host port in `.env` (`ML_SIDECAR_PORT=...`, `DB_PORT=...`) and re-run `docker compose up -d`.
> The backend reaches the sidecar via `ML_SIDECAR_URL` (default `http://localhost:8008`).

---

## 6. Install dependencies

```bash
cd backend  && npm install
cd ../frontend && npm install
cd ..
```

---

## 7. Initialize the database + load data (first time only)

Run these from the **`backend/`** directory, in order:

```bash
cd backend

npm run migrate     # 1. create all tables (idempotent — safe to re-run)
npm run seed        # 2. insert the tracked instruments (watchlist)
npm run backfill    # 3. fetch price history from Yahoo for each instrument
npm run backtest    # 4. walk-forward backfill of model predictions -> leaderboard
```

What each does:
1. **migrate** — creates the schema (instruments, prices, portfolios, predictions, and the
   competition tables). Re-running is safe.
2. **seed** — registers the default watchlist tickers. Edit `backend/scripts/seed.js` to
   change them, then re-run.
3. **backfill** — pulls historical daily closes (Yahoo is throttled, so this takes a few
   minutes). For deeper history later, use the **"Backfill prices"** card on the Overview.
4. **backtest** — replays every model over the last ~180 trading days so the Predictions
   leaderboard isn't empty. Needs the ML sidecar running (step 5) for the XGBoost/LightGBM
   models; if it's down, those two are skipped and the rest still populate. Takes a few
   minutes.

---

## 8. Run the app

Open **two terminals**:

```bash
# Terminal 1 — backend (port 4000)
cd backend && npm run dev
```

```bash
# Terminal 2 — frontend (port 5173)
cd frontend && npm run dev
```

> Windows PowerShell 5.1 doesn't support `&&` — run `cd backend` and `npm run dev` as two
> separate commands (or use PowerShell 7 / CMD).

Then open **http://localhost:5173**.

---

## 9. Verify it works

- **Overview** loads with market metrics, FX, VIX, and Gold cards.
- **Portfolios** lists portfolios (empty until you create one).
- **Predictions** shows a populated leaderboard; toggle 5d/30d and pick a stock to re-scope.
- API smoke test:
  ```bash
  curl http://localhost:4000/api/health                 # {"ok":true,...}
  curl "http://localhost:4000/api/leaderboard?horizon=5" # ranked models
  ```
- Backend tests:
  ```bash
  cd backend && npm test
  ```

---

## 10. Day-to-day: start / stop

**Start** (after the one-time setup):
```bash
docker compose up -d mysql ml-sidecar      # if not already running
cd backend && npm run dev                  # terminal 1
cd frontend && npm run dev                 # terminal 2
```

**Stop:**
```bash
# Ctrl-C in each npm terminal, then:
docker compose stop          # stop containers (keeps data)
# or
docker compose down          # remove containers (DB data persists in the named volume)
```

Your data lives in the `mysql_data` Compose volume, so it survives `stop`/`down`. To wipe
everything (including data): `docker compose down -v`. (Stopping the runtime entirely:
`colima stop` — your container data persists.)

---

## 11. Running without the ML sidecar (optional)

The two boosting models (`gbm-v1`, `gbm-lgbm-v1`) need the sidecar. Everything else works
without it. If you don't start `ml-sidecar`, the backend logs a warning and simply skips
those two models — the other seven competitors and the whole app keep working.

---

## 12. Automatic daily updates

When the backend is running, a cron job (default **23:00 KST, Mon–Fri**, see
`CRON_DAILY_REFRESH`) refreshes prices + sentiment, runs all models' predictions, scores
matured ones, and refreshes the leaderboard. It only fires while the backend process is up.

---

## 13. Troubleshooting

| Symptom | Fix |
|---|---|
| `docker: Cannot connect to the Docker daemon` / `docker compose` hangs | Colima isn't running. Start it with `colima start`, then re-run the command. Check status with `colima status`. |
| `curl /health` on sidecar returns HTML / wrong app | Another service holds the port (e.g. RedisInsight on 8001). Set `ML_SIDECAR_PORT` to a free port in `.env`, `docker compose up -d ml-sidecar`, and set `ML_SIDECAR_URL` to match. |
| Backend can't connect to MySQL | Is the container up & healthy? `docker compose ps`. Check DB creds match between `.env` (root) and `backend/.env`. |
| Predictions page empty | Run `npm run backtest` (step 7.4) to populate the leaderboard. |
| Leaderboard missing the gbm models | The sidecar wasn't running during `backtest`. Start it, then re-run `npm run backtest`. |
| `node --watch` errors | Node is too old — upgrade to Node 20+. |
| Frontend loads but no data | Backend isn't running on :4000, or it errored — check terminal 1. |
| `cp`/`&&` errors on Windows | Use `Copy-Item` and run chained commands separately (or use CMD / PowerShell 7). |

---

## 14. One-shot summary (copy/paste, macOS/Linux)

```bash
git clone https://github.com/gopuma/portfolio-tracker.git && cd portfolio-tracker
docker compose up -d mysql ml-sidecar
( cd backend && npm install && npm run migrate && npm run seed && npm run backfill && npm run backtest )
( cd frontend && npm install )
# then, in two terminals:
#   cd backend  && npm run dev
#   cd frontend && npm run dev
# open http://localhost:5173
```
