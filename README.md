# Portfolio Tracker

Personal finance dashboard with daily price tracking and short-term price prediction.

**Stack**
- Frontend: React 18 + Vite
- Backend: Node.js + Express
- DB: MySQL 8
- Data: `yahoo-finance2` for prices, RSS feeds for sentiment
- Prediction: Heuristic ensemble (SMA/EMA trend + RSI momentum + sentiment + value signal)

## Project Structure

```
portfolio-tracker/
├── docker-compose.yml          # MySQL container
├── .env.example                # copy to .env
├── backend/
│   ├── src/
│   │   ├── index.js            # Express server entry
│   │   ├── db.js               # MySQL pool
│   │   ├── routes/             # REST endpoints
│   │   ├── services/           # price/sentiment/prediction logic
│   │   ├── jobs/               # cron jobs
│   │   └── migrations/         # SQL schema
│   └── scripts/
│       ├── migrate.js          # run migrations
│       ├── seed.js             # insert tracked instruments
│       └── backfill.js         # fetch N days of history
└── frontend/
    ├── vite.config.js
    └── src/                    # React app
```

## Quick Start

### 1. Start MySQL

```bash
docker compose up -d
```

This boots MySQL 8 on `localhost:3306` with database `portfolio` (root password from `.env`).

### 2. Configure environment

```bash
cp .env.example .env
# edit if you want to change DB credentials or port
```

### 3. Install dependencies

```bash
cd backend && npm install
cd ../frontend && npm install
```

### 4. Initialize database

```bash
cd backend
npm run migrate     # creates tables
npm run seed        # inserts tracked instruments
npm run backfill    # pulls 1 year of price history
```

### 5. Run

```bash
# terminal 1: backend (port 4000)
cd backend && npm run dev

# terminal 2: frontend (port 5173)
cd frontend && npm run dev
```

Open http://localhost:5173

## Tracked Instruments

US ETFs/Stocks: AMZN, TSLA, QQQ, QQQM, SCHD, SGOV, AGNC, JPST, JAAA, GLD
Korean ETFs: Timefolio US Nasdaq 100 Active, KODEX/TIGER US Dividend DJ, TIGER US Ultra-Short Treasury
Commodities: KRX Gold Spot (proxied via GLD when needed)

Edit `backend/scripts/seed.js` to add/remove tickers.

## API Endpoints

```
GET  /api/instruments                   List all tracked instruments
GET  /api/instruments/:symbol           Instrument detail + latest price
GET  /api/prices/:symbol?days=90        Historical close prices
GET  /api/sentiment/:symbol             Latest sentiment score + headlines
GET  /api/predictions/:symbol           Short-term prediction (5-day) + factor breakdown
POST /api/refresh/:symbol               Force refresh price + sentiment + prediction
GET  /api/portfolio                     Aggregate view (all instruments, latest values)
```

## Prediction Model

The heuristic ensemble combines four factors:

| Factor        | Weight | Signal                                                   |
|---------------|--------|----------------------------------------------------------|
| Trend (SMA)   | 30%    | 20-day SMA vs 50-day SMA cross direction                 |
| Momentum (RSI)| 25%    | 14-day RSI: <30 bullish, >70 bearish, mid neutral        |
| Sentiment     | 25%    | Avg RSS headline sentiment over last 7 days (-1 to +1)   |
| Value         | 20%    | Z-score of price vs 200-day mean (mean-reversion proxy)  |

Each factor returns a signal in [-1, +1]. Composite is the weighted average,
scaled by the 30-day historical volatility to produce a 5-day price target.

See `backend/src/services/prediction.js`.

## Notes

- Korean ETFs use `.KS` suffix on Yahoo Finance. Verify ticker codes match your broker.
- Sentiment uses Yahoo Finance RSS + Google News RSS — keyword presence-based scoring.
  Swap in a proper NLP model (e.g., VADER, FinBERT) for production.
- The prediction model is explanatory, not investment advice.
