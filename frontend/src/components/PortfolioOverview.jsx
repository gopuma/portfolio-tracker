import { useEffect, useState } from 'react';
import { api } from '../api.js';
import GoldGapPanel from './GoldGapPanel.jsx';
import FxRateCard from './FxRateCard.jsx';
import VixCard from './VixCard.jsx';
import MarketAnalytics from './MarketAnalytics.jsx';
import BackfillBar from './BackfillBar.jsx';

function fmtPct(n, digits = 2) {
  if (n == null || isNaN(n)) return '–';
  const s = (Number(n) * 100).toFixed(digits);
  return `${s}%`;
}

// "Data as of" caption from a YYYY-MM-DD string. Parsed as local time
// (not UTC) so the date doesn't slip a day in negative-offset zones.
function AsOf({ date }) {
  if (!date) return null;
  const dt = new Date(`${String(date).slice(0, 10)}T00:00:00`);
  if (isNaN(dt.getTime())) return null;
  const s = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Data as of {s}</span>;
}

export default function PortfolioOverview() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = () => api.portfolio().then(setData).catch(e => setErr(e.message));

  useEffect(() => {
    api.portfolio()
      .then(d => setData(d))
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">Loading portfolio…</div>;
  if (err) return <div className="error">Failed to load: {err}</div>;
  if (!data) return null;

  // Exclude market-indicator instruments (FX e.g. KRW=X, INDEX e.g. ^VIX) and the gold
  // reference instruments (GC=F, KRX-GOLD-SPOT) — these power their own cards, not holdings.
  const items = data.instruments.filter(
    i => i.market !== 'FX' && i.market !== 'INDEX' && !PROTECTED_SYMBOLS.has(i.symbol)
  );

  const avg30 = items
    .map(i => i.return_30d)
    .filter(v => v != null)
    .reduce((a, b, _i, arr) => a + b / arr.length, 0);

  const ytdReturns = items.map(i => i.return_ytd).filter(v => v != null);
  const avgYtd = ytdReturns.length
    ? ytdReturns.reduce((a, b) => a + b, 0) / ytdReturns.length
    : null;

  const threeYReturns = items.map(i => i.return_3y).filter(v => v != null);
  const avg3y = threeYReturns.length
    ? threeYReturns.reduce((a, b) => a + b, 0) / threeYReturns.length
    : null;

  const bullish = items.filter(i => (i.predicted_return ?? 0) > 0.005).length;
  const bearish = items.filter(i => (i.predicted_return ?? 0) < -0.005).length;

  // Freshness of the KPI tiles: latest close date across the tracked instruments.
  const asOfDates = items.map(i => (i.latest_date || '').slice(0, 10)).filter(Boolean);
  const asOf = asOfDates.length ? asOfDates.reduce((a, b) => (a > b ? a : b)) : null;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
        <AsOf date={asOf} />
      </div>
      <div className="grid-6">
        <Metric label="Tracked Instruments" value={items.length} />
        <Metric label="Avg 30-day Return" value={fmtPct(avg30)} color={avg30 >= 0 ? 'up' : 'down'} />
        <Metric label="Avg YTD Return" value={fmtPct(avgYtd)} color={avgYtd != null && avgYtd >= 0 ? 'up' : avgYtd != null ? 'down' : ''} />
        <Metric label="Avg 3-Year Return" value={fmtPct(avg3y)} color={avg3y != null && avg3y >= 0 ? 'up' : avg3y != null ? 'down' : ''} />
        <Metric label="Predicted Bullish (5d)" value={bullish} color="up" />
        <Metric label="Predicted Bearish (5d)" value={bearish} color="down" />
      </div>

      <FxRateCard />

      <VixCard />

      <BackfillBar onDone={() => api.portfolio().then(setData).catch(e => setErr(e.message))} />

      <GoldGapPanel />

      <MarketAnalytics instruments={data.instruments} reload={reload} />
    </>
  );
}

function Metric({ label, value, color }) {
  return (
    <div className="panel">
      <div className="metric-label">{label}</div>
      <div className={`metric ${color || ''}`}>{value}</div>
    </div>
  );
}

// Reference instruments excluded from the holdings tables (used by the gold-gap panel).
const PROTECTED_SYMBOLS = new Set(['GC=F', 'KRX-GOLD-SPOT']);
