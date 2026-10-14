import './env.js';
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
import { researchRouter } from './routes/research.js';
import { startDailyJob } from './jobs/dailyPriceJob.js';
import { localRequestGuard, securityHeaders, ALLOWED_ORIGINS, CLIENT_HEADER } from './security.js';

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
// Refuse anything that isn't this machine's own frontend (or a local tool like curl)
// before CORS, routing, or body parsing see it. See security.js.
app.use(localRequestGuard);
// Only needed when the frontend calls the API directly rather than through the Vite proxy.
app.use(cors({
  origin: [...ALLOWED_ORIGINS],
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', CLIENT_HEADER],
}));
app.use(express.json({ limit: '100kb' }));

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
app.use('/api/research', researchRouter);
app.use('/api', competitionRouter); // /api/leaderboard, /api/models, /api/backtest, /api/competition/*

// Error handler. Client errors (4xx — validation, not-found, malformed JSON) carry a
// message written for the user. Anything else is an unexpected failure whose message can
// hold SQL, schema, or upstream details, so it is logged here and the client gets a
// generic line.
app.use((err, req, res, _next) => {
  const status = Number(err.status || err.statusCode) || 500;
  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    return res.status(status).json({ error: 'Internal error' });
  }
  res.status(status).json({ error: err.message || 'Bad request' });
});

const PORT = Number(process.env.PORT || 4000);
// Loopback only: other devices on the network can't reach the API. Set HOST in .env to
// widen it — and only behind real authentication, which this app does not have.
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`Portfolio API listening on http://${HOST}:${PORT}`);
  if (process.env.NODE_ENV !== 'test') {
    startDailyJob();
  }
});
