/**
 * Lightweight sentiment service.
 *  - Fetches headlines from Yahoo Finance + Google News RSS for each ticker.
 *  - Scores each headline by keyword presence (-1..+1).
 *  - Stores daily aggregate in sentiment_scores table.
 *
 * Production note: replace `scoreHeadline` with a real NLP model (VADER, FinBERT).
 */
import Parser from 'rss-parser';
import { pool } from '../db.js';

const parser = new Parser({ timeout: 10_000 });

const POSITIVE = [
  'beat', 'beats', 'surge', 'surges', 'rally', 'rallies', 'gain', 'gains', 'gain',
  'upgrade', 'upgraded', 'outperform', 'bullish', 'record', 'profit', 'jumps',
  'breakthrough', 'strong', 'soar', 'soars', 'rises', 'top', 'tops', 'raised',
  'boost', 'boosts', 'optimistic', 'positive', 'expand', 'expansion', 'wins',
];
const NEGATIVE = [
  'miss', 'misses', 'plunge', 'plunges', 'drop', 'drops', 'fall', 'falls', 'lawsuit',
  'downgrade', 'downgraded', 'underperform', 'bearish', 'loss', 'losses', 'cuts',
  'weak', 'slump', 'slumps', 'sinks', 'tumble', 'tumbles', 'warning', 'fraud',
  'probe', 'recall', 'concern', 'concerns', 'risk', 'risks', 'decline', 'declines',
  'layoff', 'layoffs', 'slow', 'slowdown', 'crash', 'crashes',
];

function scoreHeadline(title = '') {
  const text = title.toLowerCase();
  let pos = 0, neg = 0;
  for (const w of POSITIVE) if (text.includes(w)) pos++;
  for (const w of NEGATIVE) if (text.includes(w)) neg++;
  const total = pos + neg;
  if (total === 0) return 0;
  return (pos - neg) / total; // in [-1, 1]
}

async function fetchRss(url) {
  try {
    const feed = await parser.parseURL(url);
    return feed.items || [];
  } catch (e) {
    return [];
  }
}

/**
 * Build RSS feed URLs for the given symbol.
 * Yahoo Finance has a ticker-specific feed; Google News works on a search query.
 */
function feedsFor(symbol) {
  const isKR = symbol.endsWith('.KS') || symbol.endsWith('.KQ');
  const yfTicker = isKR ? symbol : symbol.toUpperCase();
  const q = encodeURIComponent(isKR ? symbol : `${symbol} stock`);
  return [
    `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${yfTicker}&region=US&lang=en-US`,
    `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
  ];
}

export async function fetchAndStoreSentiment(instrument) {
  const feeds = feedsFor(instrument.symbol);
  const items = (await Promise.all(feeds.map(fetchRss))).flat();

  // Keep recent items (last 3 days)
  const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
  const recent = items.filter(it => {
    const t = it.isoDate ? Date.parse(it.isoDate) : (it.pubDate ? Date.parse(it.pubDate) : Date.now());
    return t >= cutoff;
  });

  const scored = recent.map(it => ({
    title: it.title || '',
    link: it.link || '',
    pubDate: it.isoDate || it.pubDate || null,
    score: scoreHeadline(it.title || ''),
  }));

  const score = scored.length === 0
    ? 0
    : scored.reduce((a, h) => a + h.score, 0) / scored.length;

  // Cap headlines stored in JSON to keep row size small
  const topN = scored.slice(0, 25);

  const today = new Date().toISOString().slice(0, 10);

  await pool.execute(
    `INSERT INTO sentiment_scores (instrument_id, score_date, score, headline_count, source, headlines_json)
     VALUES (?, ?, ?, ?, 'rss-mixed', ?)
     ON DUPLICATE KEY UPDATE
       score = VALUES(score),
       headline_count = VALUES(headline_count),
       headlines_json = VALUES(headlines_json)`,
    [instrument.id, today, score.toFixed(4), scored.length, JSON.stringify(topN)]
  );

  return {
    symbol: instrument.symbol,
    date: today,
    score,
    headline_count: scored.length,
    sample_headlines: topN.slice(0, 5),
  };
}
