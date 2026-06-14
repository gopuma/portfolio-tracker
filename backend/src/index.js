import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { instrumentsRouter } from './routes/instruments.js';
import { pricesRouter } from './routes/prices.js';
import { sentimentRouter } from './routes/sentiment.js';
import { predictionsRouter } from './routes/predictions.js';
import { portfolioRouter } from './routes/portfolio.js';
import { refreshRouter } from './routes/refresh.js';
import { goldGapRouter } from './routes/goldGap.js';
import { analyticsRouter } from './routes/analytics.js';
import { portfoliosRouter } from './routes/portfolios.js';
import { auditRouter } from './routes/audit.js';
import { competitionRouter } from './routes/competition.js';
import { startDailyJob } from './jobs/dailyPriceJob.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/instruments', instrumentsRouter);
app.use('/api/prices', pricesRouter);
app.use('/api/sentiment', sentimentRouter);
app.use('/api/predictions', predictionsRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/refresh', refreshRouter);
app.use('/api/gold-gap', goldGapRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/portfolios', portfoliosRouter);
app.use('/api/audit', auditRouter);
app.use('/api', competitionRouter); // /api/leaderboard, /api/models, /api/backtest, /api/competition/*

// Error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => {
  console.log(`Portfolio API listening on http://localhost:${PORT}`);
  if (process.env.NODE_ENV !== 'test') {
    startDailyJob();
  }
});
