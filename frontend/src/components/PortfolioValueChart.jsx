import { useEffect, useMemo, useState } from 'react';
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LabelList, ReferenceArea } from 'recharts';
import { api } from '../api.js';

function fmtMoney(n, ccy, d = 0) {
  if (n == null || isNaN(n)) return '–';
  return `${Number(n).toLocaleString(undefined, { maximumFractionDigits: d })} ${ccy || ''}`.trim();
}
// Compact labels for the axis, where a rough scale is all that's wanted: 1_250_000 -> "1.3M".
function fmtCompact(n) {
  if (n == null || isNaN(n)) return '';
  return Number(n).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });
}
// Compact with an extra digit, for the on-bar total: 1_163_146 -> "1.16M". One decimal
// rounded neighbouring months to the same "1.2M" and made them look identical when they
// differ by tens of thousands. `minimumFractionDigits` keeps the width steady across bars.
function fmtCompact2(n) {
  if (n == null || isNaN(n)) return '';
  return Number(n).toLocaleString(undefined, {
    notation: 'compact', minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}
function fmtPct(n, d = 1) {
  if (n == null || isNaN(n)) return '';
  return `${(Number(n) * 100).toFixed(d)}%`;
}
// KRW-per-USD rate: "1,384" (no decimals — the rate is always in the thousands).
function fmtFx(n) {
  if (n == null || isNaN(n)) return '';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
// 'YYYY-MM' -> "Jan '24". Built as local time so the month doesn't slip.
function fmtMonth(ym) {
  const [y, m] = (ym || '').split('-');
  if (!y || !m) return ym;
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}
// 'YYYY-MM-DD' -> "Jun 29". Built as local time so the day doesn't slip.
function fmtDay(ymd) {
  const [y, m, d] = (ymd || '').split('-');
  if (!y || !m || !d) return ymd;
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
// Sortable label of a point regardless of granularity (daily 'date' or monthly 'month').
const pointTs = p => p.date || `${p.month}-01`;
// 'YYYY-MM-DD' minus n calendar months, returned as 'YYYY-MM-DD'.
function minusMonths(ymd, n) {
  const [y, m, d] = (ymd || '').split('-').map(Number);
  const dt = new Date(y, (m - 1) - n, d || 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// Cash series carry the reserved symbol CASH:<CCY>. Labelled "Cash held in KRW" rather
// than "Cash (KRW)" — the currency names where the money sits, NOT the unit of the plotted
// value, which is always the chart's display currency.
const prettySym = s => (typeof s === 'string' && s.startsWith('CASH:') ? `Cash held in ${s.slice(5)}` : s);

const GREEN = '#34d399';
const RED = '#f87171';
const DIM = '#9aa0a6';
// The FX overlay reads as an annotation, not another holding — kept off the stack palette.
const FX_COLOR = '#e8b64c';
// Distinct stack colors; cycles if a portfolio has more holdings than colors.
const PALETTE = [
  '#4a9eff', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#22d3ee', '#fb923c', '#f472b6',
  '#60a5fa', '#4ade80', '#facc15', '#fca5a5', '#c084fc', '#67e8f9', '#fdba74', '#f9a8d4',
  '#38bdf8', '#86efac', '#fde047', '#e879f9', '#2dd4bf', '#fbbf24', '#93c5fd', '#bef264',
];
const colorAt = i => PALETTE[i % PALETTE.length];
// Cash is ONE section, not three colours competing with the holdings: a single neutral
// stone ramp, dark at the base and lightening upward, so the block reads as one unit whose
// currencies are still separable. Steps are fixed per currency (never reassigned by size)
// and the backend stacks them in the same order, so a shade always means the same money.
//
// Validated as a sequential ramp against this panel (#1a1f29): strictly monotonic in
// lightness, adjacent separation ΔE 18.2 normal / 18.1 protan, and every step clears 3:1
// contrast. Neutral on purpose — the 23-colour holdings palette covers nearly every vivid
// hue, so low chroma is what keeps a cash band from reading as a stock.
const CASH_RAMP = { KRW: '#776c60', USD: '#b0a294', JPY: '#e8e0d6' };
// Glyph stamped inside a cash band. KRW has none — its band is the largest and reads
// cleaner unmarked; the ramp position, legend name and tooltip still identify it.
const CASH_GLYPH = { USD: '$', JPY: '¥' };
const isCashSym = s => typeof s === 'string' && s.startsWith('CASH:');
const cashCcyOf = s => (isCashSym(s) ? s.slice(5) : null);
const seriesColor = (symbol, i) => (isCashSym(symbol) ? (CASH_RAMP[cashCcyOf(symbol)] || '#8b8378') : colorAt(i));

// Hypothetical pre-history start: the opening position is carried back to here and valued
// at each day's real close and FX. Nothing is written to the ledger, and the server ignores
// it for any portfolio whose own history already reaches this far back.
const BACKFILL_FROM = '2024-01-01';

// Trailing-window presets (in months). `months: null` = show all available months.
const PRESETS = [
  { label: '6M', months: 6 },
  { label: '1Y', months: 12 },
  { label: '3Y', months: 36 },
  { label: 'All', months: null },
];

const inputStyle = {
  width: 72,
  background: 'var(--panel-2)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--text)',
  padding: '6px 8px',
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums',
};

// Single sliding toggle between USD and KRW. The knob slides to the active side and the
// active label brightens. Clicking anywhere flips it.
function CurrencyToggle({ value, onChange }) {
  const isKrw = value === 'KRW';
  return (
    <div
      role="switch"
      aria-checked={isKrw}
      aria-label="Display currency"
      title="Slide to switch chart currency (USD ⟷ KRW)"
      onClick={() => onChange(isKrw ? 'USD' : 'KRW')}
      style={{
        position: 'relative', display: 'inline-flex', alignItems: 'center',
        width: 100, height: 28, borderRadius: 14, cursor: 'pointer', userSelect: 'none',
        background: 'var(--panel-2)', border: '1px solid var(--border)',
        marginRight: 4, flexShrink: 0,
      }}
    >
      {/* Sliding knob under the active label. */}
      <span
        style={{
          position: 'absolute', top: 2, left: isKrw ? 50 : 2, width: 48, height: 24,
          borderRadius: 12, background: 'var(--accent, #4a9eff)',
          transition: 'left 160ms ease',
        }}
      />
      {['USD', 'KRW'].map(c => {
        const on = value === c;
        return (
          <span
            key={c}
            style={{
              position: 'relative', zIndex: 1, flex: 1, textAlign: 'center',
              fontSize: 12, fontWeight: on ? 700 : 500,
              color: on ? '#fff' : 'var(--text-dim)',
            }}
          >
            {c}
          </span>
        );
      })}
    </div>
  );
}

// One breakdown line in the tooltip: swatch, name, value. `compact` is the two-column
// variant — the name ellipsises rather than pushing the value out of its column.
function Row({ s, ccy, hoverKey, compact }) {
  const on = hoverKey === s.key;
  const ccyOf = cashCcyOf(s.symbol);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, lineHeight: 1.45, minWidth: 0, opacity: hoverKey && !on ? 0.5 : 1 }}>
      <span
        style={{
          width: 9, height: 9, borderRadius: 2, background: s.color, flexShrink: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 7, fontWeight: 700, color: '#0d1117', lineHeight: 1,
        }}
      >
        {ccyOf ? (CASH_GLYPH[ccyOf] || '') : ''}
      </span>
      <span
        style={{
          color: '#cbd2da', flex: 1, minWidth: 0, fontWeight: on ? 700 : 400,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {prettySym(s.symbol)}
      </span>
      {/* For cash held in another currency, show the balance in its own unit and the
          converted figure, so it's never unclear which number the bar is drawn from. */}
      {!compact && s.native != null && ccyOf !== ccy && (
        <span style={{ color: DIM, fontSize: 11, flexShrink: 0 }}>{fmtMoney(s.native, ccyOf)} →</span>
      )}
      <span style={{ color: '#e6e6e6', fontWeight: on ? 700 : 400, flexShrink: 0 }}>{fmtMoney(s.value, ccy)}</span>
    </div>
  );
}

// Tooltip: per-stock breakdown for the hovered period, plus total and period-over-period
// change. `hoverKey` bolds the actively-hovered stock's row. `daily` switches the label.
function ChartTooltip({ active, payload, ccy, symbols, hoverKey, daily }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const label = daily ? fmtDay(row.date) : fmtMonth(row.month);
  const isBackfill = !!row.backfill;
  const deltaSuffix = daily ? 'DoD' : 'MoM';
  const meta = new Map(symbols.map(s => [s.key, s.symbol]));
  const order = new Map(symbols.map((s, i) => [s.key, i])); // server stack order
  const segs = payload
    // The FX overlay rides on the same tooltip payload but isn't a holding — drop it here
    // and show it on its own row instead.
    .filter(p => p.dataKey !== 'fx' && p.value != null && p.value > 0)
    .map(p => ({
      key: p.dataKey, symbol: meta.get(p.dataKey) || p.dataKey, value: p.value, color: p.color,
      native: row.native?.[p.dataKey] ?? null, // cash only
    }))
    // Cash stays one block here too, in the same order it's stacked; securities by size.
    .sort((a, b) => {
      const ac = isCashSym(a.symbol), bc = isCashSym(b.symbol);
      if (ac !== bc) return ac ? -1 : 1;
      if (ac) return order.get(a.key) - order.get(b.key);
      return b.value - a.value;
    });
  const cashCount = segs.filter(s => isCashSym(s.symbol)).length;
  const cashTotal = segs.reduce((t, s) => t + (isCashSym(s.symbol) ? s.value : 0), 0);
  // A recharts tooltip tracks the cursor, so it can never be scrolled or clicked — the mouse
  // can't reach it. Everything therefore has to FIT on screen. Every holding is listed; the
  // securities switch to two columns once there are enough that one column would run past
  // the plot area.
  const cashRows = segs.slice(0, cashCount);
  const secRows = segs.slice(cashCount);
  const secCols = secRows.length > 9 ? 2 : 1;
  const momColor = row.mom == null ? DIM : row.mom > 0 ? GREEN : row.mom < 0 ? RED : DIM;
  // A stronger won (higher KRW/USD) inflates a KRW-denominated total, so colour the FX
  // move the same way as the value move: up = green.
  const fxColor = row.fxPct == null ? DIM : row.fxPct > 0 ? GREEN : row.fxPct < 0 ? RED : DIM;
  return (
    <div style={{ background: '#1a1f29', border: '1px solid #2d3441', borderRadius: 6, padding: '8px 10px', fontSize: 12 }}>
      <div style={{ color: DIM, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
        {label}
        {/* Say it plainly on every hypothetical period — these were never traded. */}
        {isBackfill && (
          <span style={{ color: '#0d1117', background: DIM, borderRadius: 3, padding: '0 4px', fontSize: 10, fontWeight: 700 }}>
            BACKFILLED
          </span>
        )}
      </div>
      <div style={{ color: '#e6e6e6', fontWeight: 600, marginBottom: 2 }}>Total {fmtMoney(row.total, ccy)}</div>
      {row.mom != null && (
        <div style={{ color: momColor, marginBottom: 6 }}>
          {row.mom > 0 ? '▲' : row.mom < 0 ? '▼' : ''} {fmtMoney(Math.abs(row.mom), ccy)}
          {row.momPct != null ? ` (${fmtPct(Math.abs(row.momPct))})` : ''} {deltaSuffix}
        </div>
      )}
      {/* The rate this period was valued at — part of the move whenever the display
          currency differs from a holding's own currency. */}
      {row.fx != null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid #2d3441' }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, background: FX_COLOR, flexShrink: 0 }} />
          <span style={{ color: '#cbd2da', flex: 1 }}>USD/KRW</span>
          <span style={{ color: '#e6e6e6' }}>₩{fmtFx(row.fx)}</span>
          {row.fxPct != null && (
            <span style={{ color: fxColor }}>
              {row.fxPct > 0 ? '▲' : row.fxPct < 0 ? '▼' : ''}{fmtPct(Math.abs(row.fxPct))}
            </span>
          )}
        </div>
      )}
      {/* Cash block: full width, since each row carries a native → converted pair. */}
      {cashRows.map(s => <Row key={s.symbol} s={s} ccy={ccy} hoverKey={hoverKey} />)}
      {cashRows.length > 0 && (
        <div style={{ display: 'flex', gap: 6, lineHeight: 1.45, paddingBottom: 4, marginBottom: 4, borderBottom: '1px solid #2d3441' }}>
          <span style={{ width: 9, flexShrink: 0 }} />
          <span style={{ color: DIM, flex: 1 }}>Cash subtotal</span>
          <span style={{ color: DIM }}>{fmtMoney(cashTotal, ccy)}</span>
        </div>
      )}
      {/* Securities: every one of them. Past a handful they go two-up, which halves the
          height — the only way to show them all, since this popup can't be scrolled. */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${secCols}, minmax(0, 1fr))`, columnGap: 14 }}>
        {secRows.map(s => <Row key={s.symbol} s={s} ccy={ccy} hoverKey={hoverKey} compact={secCols > 1} />)}
      </div>
    </div>
  );
}

// Label drawn above the top of each stacked bar: the period's total value with its
// period-over-period change beneath (DoD in daily view, MoM in monthly). Attached to
// the top series so y is the stack top. Bars too narrow to fit legible text are skipped.
function makeTotalLabel(data) {
  return function TotalLabel({ x, y, width, index }) {
    const d = data[index];
    if (!d || x == null || y == null) return null;
    if (width != null && width < 12) return null;
    const cx = x + width / 2;
    let momText = '';
    let momColor = DIM;
    if (d.mom != null) {
      momColor = d.mom > 0 ? GREEN : d.mom < 0 ? RED : DIM;
      const arrow = d.mom > 0 ? '▲' : d.mom < 0 ? '▼' : '';
      momText = `${arrow} ${d.momPct != null ? fmtPct(Math.abs(d.momPct)) : fmtCompact(Math.abs(d.mom))}`;
    }
    return (
      <g>
        <text x={cx} y={y - 16} textAnchor="middle" fontSize={11} fontWeight={600} fill="#e6e6e6">{fmtCompact2(d.total)}</text>
        {momText && <text x={cx} y={y - 4} textAnchor="middle" fontSize={10} fill={momColor}>{momText}</text>}
      </g>
    );
  };
}

// Label drawn inside the foot of each bar: the KRW/USD rate that period was valued at,
// with its period-over-period change beneath, on a translucent plate so it stays legible
// over any stack colour. Attached to the BOTTOM series, so y + height is the shared
// baseline and the label is drawn upward from there.
//
// It must stay within that bottom segment: recharts paints each Bar's labels with that
// Bar, so anything spilling above would be covered by the segments stacked on top.
// Segments too small for the plate are skipped — the overlay line and tooltip still
// carry the rate for those periods. Tight bars drop the change line and keep the rate.
const FX_PLATE_W = 46;
const FX_PLATE_H = 27;
const FX_PLATE_H_TIGHT = 16; // rate only, no change line
function makeFxLabel(data) {
  return function FxLabel({ x, y, width, height, index }) {
    const d = data[index];
    if (!d || d.fx == null || x == null || y == null) return null;
    if (width != null && width < FX_PLATE_W) return null; // too narrow to read
    // The plate has to fit inside this segment; drop the change line if only the rate fits.
    const full = height > FX_PLATE_H + 5;
    if (!full && !(height > FX_PLATE_H_TIGHT + 5)) return null;
    const plateH = full ? FX_PLATE_H : FX_PLATE_H_TIGHT;
    const cx = x + width / 2;
    const base = y + height; // baseline of the stack
    const pct = d.fxPct;
    const pctColor = pct == null ? '#e6e6e6' : pct > 0 ? GREEN : pct < 0 ? RED : DIM;
    return (
      <g>
        <rect
          x={cx - FX_PLATE_W / 2} y={base - plateH - 3} width={FX_PLATE_W} height={plateH}
          rx={4} fill="#0d1117" fillOpacity={0.72}
        />
        <text x={cx} y={base - (full ? 18 : 7)} textAnchor="middle" fontSize={10} fontWeight={600} fill={FX_COLOR}>
          ₩{fmtFx(d.fx)}
        </text>
        {full && pct != null && (
          <text x={cx} y={base - 7} textAnchor="middle" fontSize={9} fill={pctColor}>
            {pct > 0 ? '▲' : pct < 0 ? '▼' : ''}{fmtPct(Math.abs(pct))}
          </text>
        )}
      </g>
    );
  };
}

// Share count printed inside a bar segment. Only drawn when few enough holdings are
// selected that the segments are tall enough to read — with a full stack of 17 the bands
// are a few pixels each and the numbers would be a smear.
function makeVolumeLabel(data, key) {
  return function VolumeLabel({ x, y, width, height, index }) {
    const n = data[index]?.shares?.[key];
    if (n == null || x == null || y == null) return null;
    if (!(height > 13) || !(width > 30)) return null;
    return (
      <text
        x={x + width / 2} y={y + height / 2} textAnchor="middle" dominantBaseline="central"
        fontSize={10} fontWeight={600} fill="#0d1117" fillOpacity={0.8} pointerEvents="none"
      >
        {Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}
      </text>
    );
  };
}

// Currency glyph centred in a cash segment — the secondary encoding that keeps the $ and
// ¥ bands separable without relying on colour (CVD, print, or simply a busy stack). Drawn
// only where the band is big enough to hold it legibly; the legend and tooltip always name it.
function makeCashLabel(ccy) {
  const glyph = CASH_GLYPH[ccy];
  return function CashLabel({ x, y, width, height }) {
    if (!glyph || x == null || y == null || !(height > 13) || !(width > 20)) return null;
    return (
      <text
        x={x + width / 2} y={y + height / 2} textAnchor="middle" dominantBaseline="central"
        fontSize={11} fontWeight={700} fill="#0d1117" fillOpacity={0.75} pointerEvents="none"
      >
        {glyph}
      </text>
    );
  };
}

// Monthly AVERAGE total asset value, stacked by stock. The backend reconstructs the
// holdings you actually held each month from the holding change log and averages their
// value across the month's trading days — so this is your real month-over-month record,
// updating automatically as you edit holdings. `reloadKey` changing forces a refetch
// (e.g. right after a holding is added, edited, or removed).
export default function PortfolioValueChart({ portfolioId, base, reloadKey }) {
  const [resp, setResp] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  // Stock currently hovered (in the chart or legend); highlights it everywhere.
  const [hoverKey, setHoverKey] = useState(null);
  // Trailing window in months to display (null = all available).
  const [rangeMonths, setRangeMonths] = useState(null);
  const [draft, setDraft] = useState('');
  // 'monthly' = each bar is the month's average; 'daily' = each bar is a day's close.
  const [granularity, setGranularity] = useState('monthly');
  const daily = granularity === 'daily';
  // Display currency for the chart. Defaults to the portfolio's base; the backend
  // re-denominates using each day's FX rate (historically accurate).
  const [displayCcy, setDisplayCcy] = useState(base || 'USD');
  // Show the KRW/USD rate each period was valued at: on the bars and as an overlay line.
  const [showFx, setShowFx] = useState(true);
  // Which series are shown. null = all (the default); otherwise a Set of series keys.
  // Kept as keys rather than symbols so it survives a currency switch.
  const [picked, setPicked] = useState(null);
  const [filterOpen, setFilterOpen] = useState(false);
  // Fold cash balances into the stack. Off by default so the chart stays a picture of the
  // invested position; a large idle balance otherwise flattens the securities trend.
  const [showCash, setShowCash] = useState(false);

  const applyDraft = () => {
    const n = Math.round(Number(draft));
    if (!n || n < 1) return;
    setRangeMonths(n);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setHoverKey(null);
    api.portfolioValueHistory(portfolioId, granularity, displayCcy, BACKFILL_FROM, showCash)
      .then(d => { if (!cancelled) setResp(d); })
      .catch(e => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [portfolioId, reloadKey, granularity, displayCcy, showCash]);

  const ccy = resp?.base_currency || base;
  const symbols = resp?.symbols || [];
  // Attach period-over-period change (absolute and %) to each point for label/tooltip —
  // for the total, and for the FX rate that valued it.
  const data = useMemo(() => {
    const pts = resp?.points || [];
    return pts.map((p, i) => {
      const prev = i > 0 ? pts[i - 1].total : null;
      const mom = prev != null ? p.total - prev : null;
      const momPct = prev != null && prev !== 0 ? (p.total - prev) / prev : null;
      const prevFx = i > 0 ? pts[i - 1].fx : null;
      const fxPct = prevFx != null && prevFx !== 0 && p.fx != null ? (p.fx - prevFx) / prevFx : null;
      return { ...p, mom, momPct, fxPct };
    });
  }, [resp]);
  // Any FX at all to show? (A USD-only portfolio still gets rates; a gap in FX history won't.)
  const hasFx = useMemo(() => data.some(p => p.fx != null), [data]);
  // The series actually drawn. A null pick means everything.
  const shown = useMemo(
    () => (picked == null ? symbols : symbols.filter(x => picked.has(x.key))),
    [symbols, picked]
  );
  // With only a few holdings on screen the segments are tall enough to carry their share
  // count; past that the numbers overlap into noise. Cash is excluded from the count and
  // from the labels — a balance isn't a share count.
  const showVolume = shown.filter(x => !isCashSym(x.symbol)).length < 5;
  // Which end of the selection we're at, for the All / None buttons' active state.
  const allOn = symbols.length > 0 && shown.length === symbols.length;
  const noneOn = shown.length === 0;
  const isFiltered = picked != null && shown.length !== symbols.length;
  const toggleKey = (key) => setPicked(prev => {
    const next = new Set(prev == null ? symbols.map(x => x.key) : prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    if (next.size === symbols.length) return null; // back to "all"
    return next;
  });
  // Did the server actually backfill? It declines a start date the ledger already covers.
  const backfilled = resp?.backfill_from || null;

  // Trailing window for display: keep points within `rangeMonths` calendar months of the
  // latest one (works for both daily and monthly). The change on each point is already
  // relative to its true previous point (computed on the full series), so this is safe.
  const visible = useMemo(() => {
    if (rangeMonths == null || data.length === 0) return data;
    const cutoff = minusMonths(pointTs(data.at(-1)), rangeMonths);
    return data.filter(p => pointTs(p) > cutoff);
  }, [data, rangeMonths]);

  // Category range to shade as hypothetical. The band scale places a category at its
  // band's left edge, so the shading ends at the first REAL period — that's exactly the
  // right edge of the last backfilled bar.
  const backfillBand = useMemo(() => {
    const key = daily ? 'date' : 'month';
    const first = visible.find(p => p.backfill);
    if (!first) return null;
    const firstReal = visible.find(p => !p.backfill);
    return { x1: first[key], x2: (firstReal || visible.at(-1))[key] };
  }, [visible, daily]);

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ margin: '0 0 4px' }}>
          {daily ? 'Daily Close Trend' : 'Monthly Average Asset Value'}
        </h2>
        {/* marginLeft:auto + flex-end keeps the controls on the right edge even when the
            row wraps under the heading, or when the controls wrap among themselves. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginLeft: 'auto', justifyContent: 'flex-end' }}>
          {/* Display-currency slide toggle. Re-denominates every bar (backend converts with
              each day's FX rate); KRW cash — when shown — is added at face value, not reconverted. */}
          <CurrencyToggle value={displayCcy} onChange={setDisplayCcy} />
          {PRESETS.map(p => (
            <button
              key={p.label}
              className={`btn ${rangeMonths === p.months ? '' : 'ghost'}`}
              onClick={() => { setRangeMonths(p.months); setDraft(p.months == null ? '' : String(p.months)); }}
            >
              {p.label}
            </button>
          ))}
          <input
            type="number" min={1} value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') applyDraft(); }}
            placeholder="#"
            style={inputStyle}
          />
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>months</span>
          <button className="btn" onClick={applyDraft}>Apply</button>
          {/* Toggle daily ↔ monthly. Label names the view you'll switch TO. */}
          <button
            className="btn"
            style={{ marginLeft: 4 }}
            onClick={() => setGranularity(g => (g === 'daily' ? 'monthly' : 'daily'))}
            title={daily ? 'Switch to the monthly-average view' : 'Switch to the daily-close view'}
          >
            {daily ? 'Monthly' : 'Daily'}
          </button>
          {/* Multi-select over the holdings shown in the stack. */}
          <div style={{ position: 'relative' }}>
            <button
              className={`btn ${isFiltered ? '' : 'ghost'}`}
              onClick={() => setFilterOpen(o => !o)}
              title="Choose which holdings the chart shows"
            >
              {isFiltered ? `${shown.length}/${symbols.length} holdings` : 'All holdings'} ▾
            </button>
            {filterOpen && (
              <>
                {/* Click-away layer, so the panel closes without a document listener. */}
                <div onClick={() => setFilterOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
                <div
                  style={{
                    position: 'absolute', zIndex: 31, right: 0, marginTop: 4, width: 260,
                    maxHeight: 320, overflowY: 'auto', textAlign: 'left',
                    background: 'var(--panel-2)', border: '1px solid var(--border)',
                    borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.45)', padding: 6,
                  }}
                >
                  {/* Whichever end of the range you're at is filled rather than ghosted, so
                      the buttons read as the current state and not just as two actions. */}
                  <div style={{ display: 'flex', gap: 6, padding: '2px 4px 6px' }}>
                    <button
                      className={`btn ${allOn ? '' : 'ghost'}`} style={{ flex: 1 }}
                      onClick={() => setPicked(null)}
                    >
                      All
                    </button>
                    <button
                      className={`btn ${noneOn ? '' : 'ghost'}`} style={{ flex: 1 }}
                      onClick={() => setPicked(new Set())}
                    >
                      None
                    </button>
                  </div>
                  {symbols.map((sy) => {
                    const i = symbols.findIndex(x => x.key === sy.key);
                    const on = picked == null || picked.has(sy.key);
                    return (
                      <label
                        key={sy.key}
                        onMouseEnter={() => setHoverKey(sy.key)}
                        onMouseLeave={() => setHoverKey(null)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, padding: '4px 4px',
                          fontSize: 12, cursor: 'pointer', borderRadius: 4,
                          background: hoverKey === sy.key ? 'var(--panel)' : 'transparent',
                        }}
                      >
                        <input type="checkbox" checked={on} onChange={() => toggleKey(sy.key)} />
                        <span style={{ width: 10, height: 10, borderRadius: 2, background: seriesColor(sy.symbol, i), flexShrink: 0 }} />
                        <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {prettySym(sy.symbol)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </div>
          {/* Fold cash balances into the stack, converted at the same rate as everything else. */}
          <button
            className={`btn ${showCash ? '' : 'ghost'}`}
            style={{ marginLeft: 4 }}
            onClick={() => setShowCash(v => !v)}
            title={showCash
              ? 'Show invested securities only'
              : 'Include cash balances, converted into the display currency at each period\u2019s rate'}
          >
            + Cash
          </button>
          {/* FX rate: on-bar figure + overlay line on the right axis. */}
          <button
            className={`btn ${showFx ? '' : 'ghost'}`}
            style={{ marginLeft: 4 }}
            onClick={() => setShowFx(v => !v)}
            title={showFx ? 'Hide the USD/KRW rate' : 'Show the USD/KRW rate each period was valued at'}
          >
            ₩/$ FX
          </button>
        </div>
      </div>
      {daily ? (
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          Each point is your portfolio's total value at that <strong style={{ color: 'var(--text)' }}>trading day's close</strong>
          {' '}(in {ccy}), broken down by stock — the holdings you actually held that day valued at its closing prices.
          The figure on top is that day’s total, with its day-over-day change beneath.
          {showFx && hasFx && ' At the foot of each bar (and on the dashed right-axis line) is the USD/KRW rate that valued it.'}
          {showCash && ` Cash is included and every band is plotted in ${ccy} — a balance held in another currency is converted at that day's rate (hover to see both figures).`}
          {' '}Hover any point for the
          per-stock breakdown. Switch back to <strong style={{ color: 'var(--text)' }}>Monthly</strong> for each month's average.
        </p>
      ) : (
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          Each point is your portfolio's <strong style={{ color: 'var(--text)' }}>average</strong> total value across that month —
          the holdings you actually held then, valued at every business day's close (in {ccy}) and averaged, broken down by stock.
          The figure on top is the month’s average, with its month-over-month change beneath.
          {showFx && hasFx && ` At the foot of each bar (and on the dashed right-axis line) is the month's average USD/KRW rate —
            when the bars are read in KRW, part of every move is the currency, not the stocks.`}
          {showCash && ` Cash sits as one block at the base of each bar, plotted in ${ccy}: unlike the securities above it, a balance is
            shown as the month's closing figure rather than an average, converted at that day's rate — a deposit made mid-month reads at
            its full size. Hover to see each balance in its own currency alongside the converted figure.`}
          {' '}Switch to{' '}
          <strong style={{ color: 'var(--text)' }}>Daily</strong> to see each day's closing total.
        </p>
      )}
      {isFiltered && (
        <p style={{ margin: '-6px 0 12px', fontSize: 12, color: 'var(--amber, #f5a623)', lineHeight: 1.6 }}>
          Showing {shown.length} of {symbols.length} holdings — the bars are a partial total, so the on-bar figure is hidden.
          {showVolume && ' The number inside each band is the shares held that month.'}
        </p>
      )}
      {/* Only when the server actually reconstructed something — a portfolio whose own
          history already reaches back that far has nothing hypothetical to disclaim. */}
      {backfilled && !loading && !err && (
        <p style={{ margin: '-6px 0 12px', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          The shaded periods from <strong style={{ color: 'var(--text)' }}>{fmtMonth(backfilled.slice(0, 7))}</strong> up to
          your first recorded trade are <strong style={{ color: 'var(--text)' }}>hypothetical</strong>: the position you opened
          with, held at those same share counts and valued at each day's real close and exchange rate. They come from no
          transaction of yours — your ledger, cost basis, gains and cash are untouched by this. A holding that hadn't listed
          yet is simply absent from the months before it existed.
        </p>
      )}
      {loading ? (
        <div className="loading">Loading {daily ? 'daily' : 'monthly'} value…</div>
      ) : err ? (
        <div className="error">Failed to load: {err}</div>
      ) : data.length === 0 ? (
        <div className="loading">Not enough price history yet to chart {daily ? 'daily' : 'monthly'} value.</div>
      ) : (
        <>
          <div style={{ width: '100%', height: 340 }}>
            <ResponsiveContainer>
              <ComposedChart data={visible} margin={{ top: 28, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" />
                {/* Everything left of your first recorded trade is reconstructed, not lived. */}
                {backfillBand && (
                  <ReferenceArea
                    x1={backfillBand.x1} x2={backfillBand.x2}
                    fill="#9aa0a6" fillOpacity={0.09} stroke="none"
                    label={{ value: 'backfilled', position: 'insideTopLeft', fill: DIM, fontSize: 10 }}
                  />
                )}
                <XAxis dataKey={daily ? 'date' : 'month'} tickFormatter={daily ? fmtDay : fmtMonth} stroke="#9aa0a6" fontSize={11} minTickGap={20} />
                <YAxis
                  stroke="#9aa0a6" fontSize={11} width={52} tickFormatter={fmtCompact}
                  // Headroom so the on-bar total labels aren't clipped.
                  domain={[0, max => (max > 0 ? max * 1.18 : 1)]}
                />
                {/* Right-hand scale for the FX overlay, zoomed to the rate's own range so
                    its swings are visible next to the much larger value scale. */}
                {showFx && hasFx && (
                  <YAxis
                    yAxisId="fx" orientation="right" stroke={FX_COLOR} fontSize={10} width={46}
                    tickFormatter={fmtFx}
                    domain={[min => (min > 0 ? min * 0.97 : 0), max => (max > 0 ? max * 1.03 : 1)]}
                  />
                )}
                <Tooltip cursor={false} content={<ChartTooltip ccy={ccy} symbols={symbols} hoverKey={hoverKey} daily={daily} />} />
                {shown.map((s) => {
                  const i = symbols.findIndex(x => x.key === s.key);
                  const isTop = s.key === shown[shown.length - 1].key;
                  const dim = hoverKey && hoverKey !== s.key;
                  const cashCcy = cashCcyOf(s.symbol);
                  return (
                    <Bar
                      key={s.key} dataKey={s.key} name={s.symbol} stackId="v"
                      fill={seriesColor(s.symbol, i)} maxBarSize={72} fillOpacity={dim ? 0.25 : 1}
                      radius={isTop ? [2, 2, 0, 0] : [0, 0, 0, 0]}
                      // A hairline in the panel colour separates touching segments, so the
                      // cash bands read as their own blocks rather than one mass.
                      stroke="#1a1f29" strokeWidth={cashCcy ? 1 : 0}
                      onMouseEnter={() => setHoverKey(s.key)}
                      onMouseLeave={() => setHoverKey(null)}
                    >
                      {/* Currency glyph inside each cash band — identity without colour. */}
                      {cashCcy && CASH_GLYPH[cashCcy] && <LabelList content={makeCashLabel(cashCcy)} />}
                      {/* Shares held, inside the segment, when the stack is short enough. */}
                      {!cashCcy && showVolume && <LabelList content={makeVolumeLabel(visible, s.key)} />}
                      {/* On-bar total value + period-over-period % change (DoD daily, MoM monthly). */}
                      {isTop && !isFiltered && <LabelList content={makeTotalLabel(visible)} />}
                      {/* The FX rate that valued this bar, at its foot (bottom segment only). */}
                      {s.key === shown[0].key && showFx && hasFx && <LabelList content={makeFxLabel(visible)} />}
                    </Bar>
                  );
                })}
                {/* USD/KRW overlay on the right axis — declared last so it draws over the
                    bars. Shows how much of the trend is the currency rather than the stocks. */}
                {showFx && hasFx && (
                  <Line
                    yAxisId="fx" dataKey="fx" name="USD/KRW" type="monotone"
                    stroke={FX_COLOR} strokeWidth={1.5} strokeDasharray="4 3"
                    dot={false} activeDot={{ r: 3, fill: FX_COLOR }}
                    isAnimationActive={false}
                    connectNulls
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Scrollable, interactive legend. Hovering an item highlights that stock's
              segments in the chart (and vice-versa) via the shared hoverKey. */}
          <div
            style={{
              display: 'flex', flexWrap: 'wrap', gap: '4px 14px',
              maxHeight: 92, overflowY: 'auto', marginTop: 10, paddingTop: 8,
              borderTop: '1px solid var(--border)',
            }}
          >
            {showFx && hasFx && (
              <div
                title="USD/KRW rate used to value each period (right axis)"
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'default' }}
              >
                <span style={{ width: 10, height: 0, borderTop: `2px dashed ${FX_COLOR}`, flexShrink: 0 }} />
                <span style={{ color: 'var(--text)' }}>USD/KRW</span>
              </div>
            )}
            {symbols.map((s) => {
              const i = symbols.findIndex(x => x.key === s.key);
              const on = hoverKey === s.key;
              const off = picked != null && !picked.has(s.key); // filtered out
              const dim = off || (hoverKey && !on);
              return (
                <div
                  key={s.key}
                  onMouseEnter={() => setHoverKey(s.key)}
                  onMouseLeave={() => setHoverKey(null)}
                  onClick={() => toggleKey(s.key)}
                  title={off ? `Click to show ${s.symbol}` : `Click to hide ${s.symbol}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer',
                    userSelect: 'none',
                    fontWeight: on ? 700 : 400, opacity: dim ? 0.4 : 1,
                    textDecoration: off ? 'line-through' : 'none',
                  }}
                >
                  {/* Cash swatches carry the same glyph drawn on the bar, so the legend
                      and the segment are matched by shape as well as colour. */}
                  <span
                    style={{
                      width: 10, height: 10, borderRadius: 2, flexShrink: 0,
                      background: seriesColor(s.symbol, i),
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 8, fontWeight: 700, color: '#0d1117', lineHeight: 1,
                    }}
                  >
                    {cashCcyOf(s.symbol) ? (CASH_GLYPH[cashCcyOf(s.symbol)] || '') : ''}
                  </span>
                  <span style={{ color: 'var(--text)' }}>{prettySym(s.symbol)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
