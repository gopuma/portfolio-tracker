import { useEffect, useState } from 'react';
import { api } from '../api.js';

function fmtNum(n, d = 2) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtPct(n, d = 2) {
  if (n == null || isNaN(n)) return '–';
  return `${(Number(n) * 100).toFixed(d)}%`;
}

// Yahoo's session state: 'REGULAR' = the market is open and the price is live; anything
// else ('PRE', 'POST', 'CLOSED', 'PREPRE', 'POSTPOST') means closed → price is the last close.
const isOpen = q => q?.market_state === 'REGULAR';

// Major equity indices to surface at the top of the overview, seeded as INDEX instruments.
const INDICES = [
  { symbol: '^GSPC', label: 'S&P 500', unit: 'USD' },
  { symbol: '^DJI', label: 'Dow Jones', unit: 'USD' },
  { symbol: '^IXIC', label: 'NASDAQ', unit: 'USD' },
  { symbol: '^SOX', label: 'PHLX Semi', unit: 'USD' },
  { symbol: '^KS11', label: 'KOSPI', unit: 'KRW' },
];

const SYMBOLS = INDICES.map(i => i.symbol);
const POLL_MS = 60_000; // refresh live quotes once a minute while the page is open

// Compact cards: each index's price (live when its market is open, else the latest close)
// and its change vs the previous close. Quotes are fetched in one batch call and polled.
export default function IndexCards() {
  const [quotes, setQuotes] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = () => api.liveQuotes(SYMBOLS)
      .then(d => { if (!cancelled) { setQuotes(d.quotes || {}); setErr(null); } })
      .catch(e => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    load();
    const t = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return (
    <div className="grid-5">
      {INDICES.map(i => (
        <IndexCard key={i.symbol} {...i} quote={quotes?.[i.symbol]} loading={loading} err={err} />
      ))}
    </div>
  );
}

function IndexCard({ symbol, label, unit, quote, loading, err }) {
  const price = quote?.price != null ? Number(quote.price) : null;
  const prev = quote?.previous_close != null ? Number(quote.previous_close) : null;
  const change = quote?.change != null ? Number(quote.change) : (price != null && prev != null ? price - prev : null);
  const changePct = change != null && prev ? change / prev : null;
  const color = change == null ? '' : change > 0 ? 'up' : change < 0 ? 'down' : '';
  const open = isOpen(quote);

  return (
    <div className="panel">
      <div className="metric-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span>{label}</span>
        <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'none', letterSpacing: 0 }}>{symbol}</span>
      </div>

      {loading && price == null ? (
        <div className="metric" style={{ color: 'var(--text-dim)' }}>…</div>
      ) : price == null ? (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8 }}>
          {err ? `Failed: ${err}` : <>No data — backfill <code>{symbol}</code>.</>}
        </div>
      ) : (
        <>
          <div className="metric" style={{ fontSize: 26 }}>
            {fmtNum(price)} <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 400 }}>{unit}</span>
          </div>
          <div className={color} style={{ fontSize: 14, marginTop: 2 }}>
            {change == null ? (
              <span style={{ color: 'var(--text-dim)' }}>– no prior close</span>
            ) : (
              <>
                {change > 0 ? '▲' : change < 0 ? '▼' : ''} {fmtNum(Math.abs(change))} ({fmtPct(changePct == null ? null : Math.abs(changePct))})
              </>
            )}
          </div>
          <MarketState open={open} quote={quote} />
        </>
      )}
    </div>
  );
}

// Small badge: a green "LIVE" dot while the market is open, else "At close · <when>".
function MarketState({ open, quote }) {
  if (open) {
    return (
      <div style={{ fontSize: 11, color: 'var(--green)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} />
        LIVE
      </div>
    );
  }
  const when = quote?.time ? new Date(quote.time) : null;
  const label = when && !isNaN(when.getTime())
    ? when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;
  return (
    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
      At close{label ? ` · ${label}` : ''}
    </div>
  );
}
