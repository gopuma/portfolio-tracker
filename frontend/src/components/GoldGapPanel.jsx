import { useEffect, useMemo, useState } from 'react';
import { ComposedChart, LineChart, Line, Area, Brush, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { api } from '../api.js';
import { rowsOf, intlKrwPerGram, mergeGold, averages, axisRange } from '../goldSeries.js';

const KRX_SYMBOL = 'KRX-GOLD-SPOT';
const INTL_SYMBOL = 'GC=F';
const FX_SYMBOL = 'KRW=X';
const MAX_DAYS = 1825;

// Trend-chart period presets (history caps at 1825 days / 5y).
const PRESETS = [
  { label: '1Y', days: 365 },
  { label: '3Y', days: 1095 },
  { label: '5Y', days: 1825 },
];

const KRX_COLOR = '#fbbf24';  // amber
const INTL_COLOR = '#4a9eff'; // blue

function fmtNum(n, digits = 2) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtPct(n, digits = 2) {
  if (n == null || isNaN(n)) return '–';
  return `${(Number(n) * 100).toFixed(digits)}%`;
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

function fmtKstTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
}

export default function GoldGapPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [krxHist, setKrxHist] = useState(null);
  const [intlHist, setIntlHist] = useState(null);
  const [fxHist, setFxHist] = useState(null);

  useEffect(() => {
    const load = () => api.goldGap().then(setData).catch(e => setErr(e.message));
    load();
    // Auto-refresh every 60s so live KRX prices stay current while market is open.
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  // Fetch full history once for the 1Y/3Y/5Y averages (fixed, independent of live data).
  useEffect(() => {
    api.prices(KRX_SYMBOL, MAX_DAYS).then(d => setKrxHist(d.prices || [])).catch(() => {});
    api.prices(INTL_SYMBOL, MAX_DAYS).then(d => setIntlHist(d.prices || [])).catch(() => {});
    api.prices(FX_SYMBOL, MAX_DAYS).then(d => setFxHist(d.prices || [])).catch(() => {});
  }, []);

  const krxRows = useMemo(() => rowsOf(krxHist), [krxHist]);
  // International gold in KRW/g at each day's exchange rate, so both share one unit.
  const intlRows = useMemo(() => intlKrwPerGram(rowsOf(intlHist), rowsOf(fxHist)), [intlHist, fxHist]);
  const krxAvgs = useMemo(() => averages(krxRows), [krxRows]);
  const intlAvgs = useMemo(() => averages(intlRows), [intlRows]);

  // Latest close date across both series — the freshness of the trend/averages.
  const lastDataDate = useMemo(() => {
    const dates = [...(krxHist || []), ...(intlHist || [])]
      .map(p => (p.trade_date || '').slice(0, 10))
      .filter(Boolean);
    return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
  }, [krxHist, intlHist]);

  const [days, setDays] = useState(365); // chart period, default 1Y
  const [draft, setDraft] = useState('365'); // custom-period input buffer

  // Both series by date for the trend chart, filtered to the selected period.
  const chartData = useMemo(() => {
    const c = new Date();
    c.setDate(c.getDate() - days);
    return mergeGold(krxRows, intlRows, c.toISOString().slice(0, 10));
  }, [krxRows, intlRows, days]);

  // Window picked with the slider under the price chart (null: the whole period). Both
  // charts show it, and both axes refit to it, so zooming in stretches the gap.
  const [win, setWin] = useState(null);
  useEffect(() => setWin(null), [days]);
  const shown = useMemo(
    () => (win ? chartData.slice(win.startIndex, win.endIndex + 1) : chartData),
    [chartData, win]
  );

  // Daily premium over the window, and its average.
  const premiumData = useMemo(() => shown.filter(e => e.premium != null), [shown]);
  const avgPremium = premiumData.length ? premiumData.reduce((a, e) => a + e.premium, 0) / premiumData.length : null;

  // Axes fitted to the data rather than starting near round numbers far below it. The
  // premium axis leaves the rare spike (top and bottom 1% of days) off the scale, so the
  // usual day-to-day range stays readable.
  const priceAxis = useMemo(() => axisRange(shown.flatMap(e => [e.krx, e.intl]), { ticks: 8 }), [shown]);
  const premiumAxis = useMemo(() => axisRange(premiumData.map(e => e.premium), { ticks: 7, clip: 0.01, include: [0] }), [premiumData]);

  const applyDraft = () => {
    const n = Math.round(Number(draft));
    if (!n || n < 1) return;
    setDays(Math.min(n, MAX_DAYS));
  };

  if (err) return <div className="panel"><h2>Gold Gap</h2><div className="error">Failed: {err}</div></div>;
  if (!data) return <div className="panel"><h2>Gold Gap</h2><div className="loading">Loading…</div></div>;

  const { krx, intl, fx, gap } = data;
  const pct = gap?.premium_pct;
  const pctColor = pct == null ? '' : pct > 0 ? 'up' : 'down';
  const live = krx.live;
  const liveDir = live?.direction;
  const liveColor = liveDir === 'RISING' ? 'up' : liveDir === 'FALLING' ? 'down' : '';
  const arrow = liveDir === 'RISING' ? '▲' : liveDir === 'FALLING' ? '▼' : '';
  const statusPill = live?.market_status === 'OPEN'
    ? <span className="pill green" style={{ marginLeft: 8 }}>LIVE</span>
    : <span className="pill" style={{ marginLeft: 8 }}>CLOSE</span>;

  return (
    <div className="panel">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <h2 style={{ margin: 0 }}>Gold: KRX vs International</h2>
        <AsOf date={lastDataDate} />
      </div>
      <div className="grid-3" style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="metric-label">KRX (Korean Market) {live ? statusPill : null}</div>
          <div className="metric">{fmtNum(krx.latest_krw_per_g, 2)} <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>KRW/g</span></div>
          {live ? (
            <div style={{ fontSize: 12, marginTop: 2 }}>
              <span className={liveColor}>{arrow} {fmtNum(live.fluctuation_krw, 2)} ({fmtPct(live.fluctuation_pct)})</span>
            </div>
          ) : null}
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
            {krx.display_name} · {krx.symbol}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
            {live ? `as of ${fmtKstTime(live.local_traded_at)} KST` : null}
          </div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            30d: <span className={krx.return_30d > 0 ? 'up' : krx.return_30d < 0 ? 'down' : ''}>{fmtPct(krx.return_30d)}</span>
          </div>
          <AvgBlock avgs={krxAvgs} current={krx.latest_krw_per_g} unit="KRW/g" digits={0} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="metric-label">International (US Market)</div>
          <div className="metric">{fmtNum(intl.latest_usd_per_oz, 2)} <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>USD/oz</span></div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            {intl.display_name} · {intl.symbol}
          </div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            30d: <span className={intl.return_30d > 0 ? 'up' : intl.return_30d < 0 ? 'down' : ''}>{fmtPct(intl.return_30d)}</span>
            {intl.return_30d_krw != null && (
              <span style={{ color: 'var(--text-dim)' }}>
                {' '}· in KRW <span className={intl.return_30d_krw > 0 ? 'up' : intl.return_30d_krw < 0 ? 'down' : ''}>{fmtPct(intl.return_30d_krw)}</span>
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
            ≈ {fmtNum(intl.latest_krw_per_g, 0)} KRW/g at today's rate
          </div>
          <AvgBlock avgs={intlAvgs} current={intl.latest_krw_per_g} unit="KRW/g" digits={0} />
        </div>

        <div>
          <div className="metric-label">Korean Premium (KRX − Intl)</div>
          <div className={`metric ${pctColor}`}>{fmtPct(pct)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            {fmtNum(gap?.premium_krw_per_g, 0)} KRW/g · USD/KRW {fmtNum(fx.krw_per_usd, 2)}
          </div>
          <div style={{ fontSize: 11, marginTop: 4, color: 'var(--text-dim)' }}>
            30d return diff (both in KRW): <span className={gap?.return_30d_diff > 0 ? 'up' : 'down'}>{fmtPct(gap?.return_30d_diff)}</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginTop: 16 }}>
        <h3 style={{ margin: 0 }}>Price Trend</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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
      </div>

      {chartData.length === 0 ? (
        <div className="loading">No price history yet.</div>
      ) : (
        <>
          <div style={{ width: '100%', height: 420, marginTop: 12 }}>
            <ResponsiveContainer>
              <ComposedChart data={chartData}>
                <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" />
                <XAxis dataKey="date" stroke="#9aa0a6" fontSize={11} minTickGap={40} />
                <YAxis stroke="#9aa0a6" fontSize={11} domain={priceAxis.domain} ticks={priceAxis.ticks} tickFormatter={v => fmtNum(v, 0)} width={64} />
                <Tooltip
                  contentStyle={{ background: '#1a1f29', border: '1px solid #2d3441' }}
                  formatter={(v, name) => [`${fmtNum(v, 0)} KRW/g`, name]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} verticalAlign="top" />
                {/* The gap itself, shaded: amber where KRX is above, blue where below. */}
                <Area type="monotone" dataKey="above" name="KRX above" fill={KRX_COLOR} fillOpacity={0.45} stroke="none" legendType="square" tooltipType="none" connectNulls isAnimationActive={false} />
                <Area type="monotone" dataKey="below" name="KRX below" fill={INTL_COLOR} fillOpacity={0.45} stroke="none" legendType="square" tooltipType="none" connectNulls isAnimationActive={false} />
                <Line type="monotone" dataKey="krx" name="KRX" stroke={KRX_COLOR} dot={false} strokeWidth={1.5} connectNulls isAnimationActive={false} />
                <Line type="monotone" dataKey="intl" name="International (in KRW)" stroke={INTL_COLOR} dot={false} strokeWidth={1.5} connectNulls isAnimationActive={false} />
                <Brush
                  key={days}
                  dataKey="date"
                  startIndex={win ? win.startIndex : 0}
                  endIndex={win ? win.endIndex : Math.max(0, chartData.length - 1)}
                  height={26}
                  stroke="#4a9eff"
                  fill="#1a1f29"
                  travellerWidth={8}
                  tickFormatter={() => ''}
                  onChange={r => setWin(r.startIndex === 0 && r.endIndex === chartData.length - 1 ? null : r)}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
            International gold (USD/oz) converted to KRW/g at each day's USD/KRW rate. Drag the slider's ends to zoom into a stretch of time; the scale refits so the gap shows more.
          </div>

          {premiumData.length > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginTop: 16 }}>
                <h3 style={{ margin: 0 }}>Korean Premium</h3>
                <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                  average over {win ? `${shown[0]?.date} – ${shown[shown.length - 1]?.date}` : 'the period'} <span className={avgPremium > 0 ? 'up' : avgPremium < 0 ? 'down' : ''}>{fmtPct(avgPremium)}</span>
                </span>
              </div>
              <div style={{ width: '100%', height: 220, marginTop: 8 }}>
                <ResponsiveContainer>
                  <LineChart data={premiumData}>
                    <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" />
                    <XAxis dataKey="date" stroke="#9aa0a6" fontSize={11} minTickGap={40} />
                    <YAxis stroke="#9aa0a6" fontSize={11} domain={premiumAxis.domain} ticks={premiumAxis.ticks} allowDataOverflow tickFormatter={v => fmtPct(v, 1)} width={64} />
                    <Tooltip
                      contentStyle={{ background: '#1a1f29', border: '1px solid #2d3441' }}
                      formatter={v => [fmtPct(v), 'KRX over international']}
                    />
                    <ReferenceLine y={0} stroke="#9aa0a6" />
                    <Line type="monotone" dataKey="premium" stroke={KRX_COLOR} dot={false} strokeWidth={1.5} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                KRX closes in the Seoul afternoon and international gold in the New York evening, so part of each day's premium is that day's price move.
                {premiumAxis.clipped > 0 && ` ${premiumAxis.clipped} unusual ${premiumAxis.clipped === 1 ? 'day runs' : 'days run'} off the scale; hover for the value.`}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// Compact 1Y/3Y/5Y average list with the current price's deviation from each.
function AvgBlock({ avgs, current, unit, digits = 2 }) {
  const rows = [
    ['1Y avg', avgs.y1],
    ['3Y avg', avgs.y3],
    ['5Y avg', avgs.y5],
  ];
  return (
    <div style={{ marginTop: 'auto', paddingTop: 8, borderTop: '1px solid var(--border)' }}>
      {rows.map(([label, v]) => {
        const diff = v && current != null ? current / v - 1 : null;
        const color = diff == null ? '' : diff > 0 ? 'up' : diff < 0 ? 'down' : '';
        return (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ color: 'var(--text-dim)' }}>{label}</span>
            <span>
              {fmtNum(v, digits)} <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>{unit}</span>
              {diff != null && <span className={color} style={{ marginLeft: 6 }}>{diff > 0 ? '+' : ''}{fmtPct(diff)}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
