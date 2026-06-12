import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { api } from '../api.js';

function fmtNum(n, digits = 2) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtPct(n, digits = 2) {
  if (n == null || isNaN(n)) return '–';
  return `${(Number(n) * 100).toFixed(digits)}%`;
}

// Conventional abbreviation for the runtime's local timezone (e.g. "Korea Standard
// Time" → "KST", "Pacific Daylight Time" → "PDT"). Derived from the initials of the
// long zone name so it adapts to wherever the app runs and to DST. Falls back to the
// short name (which may be "GMT+9") if no usable long name is available.
function tzAbbrev(date = new Date()) {
  const longName = new Intl.DateTimeFormat('en-US', { timeZoneName: 'long' })
    .formatToParts(date).find(p => p.type === 'timeZoneName')?.value || '';
  if (/coordinated universal/i.test(longName)) return 'UTC';
  const initials = longName.match(/\b[A-Z]/g);
  if (initials && initials.length >= 2) return initials.join('');
  return new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
    .formatToParts(date).find(p => p.type === 'timeZoneName')?.value || '';
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

// Period presets. The /prices endpoint caps history at 1825 days (5y).
const PRESETS = [
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
  { label: '3Y', days: 1095 },
  { label: '5Y', days: 1825 },
];

const MAX_DAYS = 1825;

export default function FxRateCard() {
  const [days, setDays] = useState(180); // default: last 6 months
  const [draft, setDraft] = useState('180'); // custom-period input buffer
  const [data, setData] = useState(null);
  const [history, setHistory] = useState(null); // full 5y series, for the averages
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(null);          // { price, time } real-time quote
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveErr, setLiveErr] = useState(null);

  const getLive = () => {
    setLiveLoading(true);
    setLiveErr(null);
    api.fxLive()
      .then(d => setLive(d))
      .catch(e => setLiveErr(e.message))
      .finally(() => setLiveLoading(false));
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api.fxRate(days)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days]);

  // Fetch the full 5y history once so the 1Y/3Y/5Y averages stay fixed
  // regardless of the chart's selected period.
  useEffect(() => {
    let cancelled = false;
    api.fxRate(MAX_DAYS)
      .then(d => { if (!cancelled) setHistory(d.prices || []); })
      .catch(() => { /* averages just show – if this fails */ });
    return () => { cancelled = true; };
  }, []);

  // Average close over the most recent N days of the 5y history.
  const averages = useMemo(() => {
    const rows = (history || [])
      .map(p => ({ t: (p.trade_date || '').slice(0, 10), v: Number(p.close_px) }))
      .filter(r => r.t && !isNaN(r.v));
    const avgOver = nDays => {
      if (rows.length === 0) return null;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - nDays);
      const cut = cutoff.toISOString().slice(0, 10);
      const sel = rows.filter(r => r.t >= cut);
      if (sel.length === 0) return null;
      return sel.reduce((a, r) => a + r.v, 0) / sel.length;
    };
    return { y1: avgOver(365), y3: avgOver(1095), y5: avgOver(MAX_DAYS) };
  }, [history]);

  const chartData = useMemo(
    () => (data?.prices || []).map(p => ({
      date: (p.trade_date || '').slice(0, 10),
      rate: Number(p.close_px),
    })),
    [data]
  );

  const first = chartData[0]?.rate;
  const last = chartData.at(-1)?.rate;
  const change = first != null && last != null ? last - first : null;
  const changePct = first ? change / first : null;
  const changeColor = change == null ? '' : change > 0 ? 'up' : change < 0 ? 'down' : '';

  // Human label for the selected window: a preset name (6M/1Y/…) or "<n> days".
  const periodLabel = PRESETS.find(p => p.days === days)?.label || `${days} day${days === 1 ? '' : 's'}`;

  const applyDraft = () => {
    const n = Math.round(Number(draft));
    if (!n || n < 1) return;
    setDays(Math.min(n, MAX_DAYS));
  };

  return (
    <div className="panel">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <h2 style={{ margin: 0 }}>KRW / USD Exchange Rate</h2>
        <AsOf date={chartData.at(-1)?.date} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
        <div className="metric">
          {fmtNum(last)} <span className="unit">KRW per USD</span>
        </div>
        {change != null && (
          <div className={changeColor} style={{ fontSize: 14 }}>
            {change > 0 ? '▲' : change < 0 ? '▼' : ''} {fmtNum(Math.abs(change))} ({fmtPct(changePct)})
            <span style={{ color: 'var(--text-dim)', marginLeft: 6 }}>over {periodLabel}</span>
          </div>
        )}
        {/* Live-rate control grouped with its result, set apart from the period controls above. */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {live && (
            <div style={{ fontSize: 13, color: '#f5a623', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ display: 'inline-block', width: 18, borderTop: '2px dashed #f5a623' }} />
              Live {fmtNum(live.price)} KRW/USD
              {live.time && <span style={{ color: 'var(--text-dim)' }}>· {new Date(live.time).toLocaleString()} {tzAbbrev(new Date(live.time))}</span>}
            </div>
          )}
          {liveErr && <span style={{ fontSize: 12, color: 'var(--red)' }}>Live rate failed: {liveErr}</span>}
          <button className="btn" onClick={getLive} disabled={liveLoading} title="Fetch the current real-time USD/KRW rate and overlay it on the chart as a dashed line">
            {liveLoading ? 'Fetching…' : '↻ Get live rate'}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginTop: 14 }}>
        <AvgStat label="1-Year Avg" value={averages.y1} current={last} />
        <AvgStat label="3-Year Avg" value={averages.y3} current={last} />
        <AvgStat label="5-Year Avg" value={averages.y5} current={last} />
      </div>

      {/* Chart period controls — placed just above the chart they drive. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
        {PRESETS.map(p => (
          <button
            key={p.label}
            className={`btn ${days === p.days ? '' : 'ghost'}`}
            onClick={() => { setDays(p.days); setDraft(String(p.days)); }}
          >
            {p.label}
          </button>
        ))}
        <input
          type="number"
          min={1}
          max={MAX_DAYS}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') applyDraft(); }}
          style={{
            width: 80,
            background: 'var(--panel-2)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--text)',
            padding: '6px 8px',
            fontSize: 13,
            fontVariantNumeric: 'tabular-nums',
          }}
        />
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>days</span>
        <button className="btn" onClick={applyDraft}>Apply</button>
      </div>

      {loading ? (
        <div className="loading">Loading exchange rate…</div>
      ) : err ? (
        <div className="error">Failed to load: {err}</div>
      ) : chartData.length === 0 ? (
        <div className="loading">No FX history yet — backfill <code>KRW=X</code>.</div>
      ) : (
        <div style={{ width: '100%', height: 300, marginTop: 12 }}>
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" />
              <XAxis dataKey="date" stroke="#9aa0a6" fontSize={11} minTickGap={40} />
              <YAxis stroke="#9aa0a6" fontSize={11} domain={['auto', 'auto']} tickFormatter={v => fmtNum(v, 0)} width={48} />
              <Tooltip
                contentStyle={{ background: '#1a1f29', border: '1px solid #2d3441' }}
                formatter={v => [`${fmtNum(v)} KRW/USD`, 'Rate']}
              />
              <Line type="monotone" dataKey="rate" stroke="#4a9eff" dot={false} strokeWidth={2} />
              {live?.price != null && (
                // Real-time rate as a dashed horizontal line — distinct from the EOD close series.
                <ReferenceLine
                  y={live.price}
                  stroke="#f5a623"
                  strokeDasharray="6 4"
                  strokeWidth={2}
                  ifOverflow="extendDomain"
                  label={{ value: `Live ${fmtNum(live.price)}`, position: 'insideTopRight', fill: '#f5a623', fontSize: 11 }}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// One average figure, with the current rate's deviation from that average.
function AvgStat({ label, value, current }) {
  const diffPct = value && current != null ? current / value - 1 : null;
  const color = diffPct == null ? '' : diffPct > 0 ? 'up' : diffPct < 0 ? 'down' : '';
  return (
    <div style={{ textAlign: 'left' }}>
      <div className="metric-label">{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {fmtNum(value)} <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 400 }}>KRW/USD</span>
      </div>
      {diffPct != null && (
        <div className={color} style={{ fontSize: 12 }}>
          now {diffPct > 0 ? '+' : ''}{fmtPct(diffPct)} vs avg
        </div>
      )}
    </div>
  );
}
