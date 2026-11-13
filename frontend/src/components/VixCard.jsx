import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { api } from '../api.js';
import { t, locale, isKo } from '../i18n.jsx';

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
  const s = dt.toLocaleDateString(locale(), { month: 'short', day: 'numeric', year: 'numeric' });
  return <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t('Data as of {date}', { date: s })}</span>;
}

const PRESETS = [
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
  { label: '3Y', days: 1095 },
  { label: '5Y', days: 1825 },
];
const MAX_DAYS = 1825;

// VIX regime by level — the conventional "fear gauge" bands.
function regime(v) {
  if (v == null) return { label: '–', cls: '', color: 'var(--text-dim)' };
  if (v < 12) return { label: 'Very Low — complacency', cls: 'up', color: 'var(--green)' };
  if (v < 20) return { label: 'Calm', cls: 'up', color: 'var(--green)' };
  if (v < 30) return { label: 'Elevated', cls: '', color: 'var(--amber)' };
  if (v < 40) return { label: 'High — fear', cls: 'down', color: 'var(--red)' };
  return { label: 'Extreme — panic', cls: 'down', color: 'var(--red)' };
}

export default function VixCard({ reloadKey = 0 }) {
  const [days, setDays] = useState(180);
  const [draft, setDraft] = useState('180');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  // Live quote (or the latest close when the US market is closed), fetched on load.
  const [quote, setQuote] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api.vix(days)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days, reloadKey]);

  // On every load, pull a live quote: shows the live level while the market is open,
  // otherwise the latest close. Independent of the chart's period selector.
  useEffect(() => {
    let cancelled = false;
    api.liveQuotes(['^VIX'])
      .then(d => { if (!cancelled) setQuote(d.quotes?.['^VIX'] || null); })
      .catch(() => { /* fall back to the chart's last close below */ });
    return () => { cancelled = true; };
  }, [reloadKey]);

  const chartData = useMemo(
    () => (data?.prices || []).map(p => ({ date: (p.trade_date || '').slice(0, 10), vix: Number(p.close_px) })),
    [data]
  );

  const first = chartData[0]?.vix;
  // Prefer the live/last quote for the headline; fall back to the chart's final close.
  const liveOpen = quote?.market_state === 'REGULAR';
  const last = quote?.price != null ? Number(quote.price) : chartData.at(-1)?.vix;
  const change = first != null && last != null ? last - first : null;
  const changePct = first ? change / first : null;
  // VIX up = more fear (red); VIX down = calmer (green) — inverted vs. a normal asset.
  const changeColor = change == null ? '' : change > 0 ? 'down' : change < 0 ? 'up' : '';
  const reg = regime(last);

  const applyDraft = () => {
    const n = Math.round(Number(draft));
    if (!n || n < 1) return;
    setDays(Math.min(n, MAX_DAYS));
  };

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h2 style={{ margin: 0 }}>{t('VIX — Volatility Index')}</h2>
          <AsOf date={chartData.at(-1)?.date} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {PRESETS.map(p => (
            <button key={p.label} className={`btn ${days === p.days ? '' : 'ghost'}`} onClick={() => { setDays(p.days); setDraft(String(p.days)); }}>
              {t(p.label)}
            </button>
          ))}
          <input
            type="number" min={1} max={MAX_DAYS} value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') applyDraft(); }}
            style={inputStyle}
          />
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{t('days')}</span>
          <button className="btn" onClick={applyDraft}>{t('Apply')}</button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
        <div className="metric">{fmtNum(last)}</div>
        {quote && (
          liveOpen ? (
            <span style={{ fontSize: 11, color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 5, alignSelf: 'center' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} /> {t('LIVE')}
            </span>
          ) : (
            <span style={{ fontSize: 11, color: 'var(--text-dim)', alignSelf: 'center' }}>{t('At close')}</span>
          )
        )}
        <span className="pill" style={{ background: 'transparent', border: `1px solid ${reg.color}`, color: reg.color }}>{t(reg.label)}</span>
        {change != null && (
          <div className={changeColor} style={{ fontSize: 14 }}>
            {change > 0 ? '▲' : change < 0 ? '▼' : ''} {fmtNum(Math.abs(change))} ({fmtPct(changePct)})
            <span style={{ color: 'var(--text-dim)', marginLeft: 6 }}>{t('over period')}</span>
          </div>
        )}
      </div>

      {loading && !data ? (
        <div className="loading">{t('Loading VIX…')}</div>
      ) : err ? (
        <div className="error">{t('Failed to load: {err}', { err })}</div>
      ) : chartData.length === 0 ? (
        <div className="loading">{t('No VIX history yet — backfill')} <code>^VIX</code>.</div>
      ) : (
        <div style={{ width: '100%', height: 300, marginTop: 12 }}>
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis dataKey="date" stroke="var(--text-dim)" fontSize={11} minTickGap={40} />
              <YAxis stroke="var(--text-dim)" fontSize={11} domain={['auto', 'auto']} width={36} />
              <Tooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)' }} formatter={v => [fmtNum(v), 'VIX']} />
              {/* Regime guide lines: 20 = calm/elevated boundary, 30 = fear threshold */}
              <ReferenceLine y={20} stroke="var(--amber)" strokeDasharray="4 4" label={{ value: '20', fill: 'var(--amber)', fontSize: 10, position: 'right' }} />
              <ReferenceLine y={30} stroke="var(--red)" strokeDasharray="4 4" label={{ value: '30', fill: 'var(--red)', fontSize: 10, position: 'right' }} />
              <Line type="monotone" dataKey="vix" stroke="var(--accent)" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <p style={{ marginTop: 12, marginBottom: 0, fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
        {isKo() ? (
          <>
            <strong style={{ color: 'var(--text)' }}>VIX</strong>는 옵션 가격에서 산출한 S&amp;P 500의 향후 30일 예상 변동성으로,
            흔히 "공포 지수"라고 부릅니다. 대략적인 구간: <span className="up">20 미만 안정</span>,
            <span style={{ color: 'var(--amber)' }}> 20–30 경계</span>, <span className="down"> 30 초과 공포</span>.
            주가가 떨어질 때 보통 오르므로 주식과 <em>음의 상관관계</em>를 보이는 경향이 있어, 시장 스트레스를 빠르게 가늠할 수 있습니다.
          </>
        ) : (
          <>
            The <strong style={{ color: 'var(--text)' }}>VIX</strong> is the market's expected 30-day volatility of the S&amp;P 500,
            implied from option prices — the "fear gauge." Rough bands: <span className="up">&lt; 20 calm</span>,
            <span style={{ color: 'var(--amber)' }}> 20–30 elevated</span>, <span className="down"> &gt; 30 fear</span>.
            It usually rises when stocks fall, so it tends to be <em>negatively correlated</em> with equities — a quick read on
            market stress.
          </>
        )}
      </p>
    </div>
  );
}

const inputStyle = {
  width: 80,
  background: 'var(--panel-2)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--text)',
  padding: '6px 8px',
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums',
};
