// Colours, formatting and small pieces shared by the stress test's two modes (the
// hypothetical shock and the historical replay), so both read as one page.

export const GREEN = '#34d399';
export const RED = '#f87171';
export const DIM = '#9aa0a6';
// Same roles as the other charts: the accent blue is the series being studied (the price
// line, the FX line), neutral grey is the reference it's read against (like the value
// chart's backfill band), and red/green only ever mark direction, on text.
export const ACCENT = '#4a9eff';
export const BASELINE = '#9aa0a6';
export const BASELINE_OPACITY = 0.35;
export const DIMMED_OPACITY = 0.35;
export const tooltipStyle = { background: '#1a1f29', border: '1px solid #2d3441', fontSize: 12 };
export const inputStyle = { width: 72, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '6px 8px', fontSize: 13, fontVariantNumeric: 'tabular-nums' };
export const dimLabel = { fontSize: 12, color: 'var(--text-dim)' };
export const chipStyle = { padding: '3px 10px', fontSize: 12 };

export function fmtPct(n, d = 1) {
  if (n == null || isNaN(n)) return '–';
  const s = (Number(n) * 100).toFixed(d);
  if (Number(s) === 0) return `${(0).toFixed(d)}%`; // no "−0%" for a value that rounds away
  return `${n > 0 ? '+' : ''}${s}%`;
}
export function fmtNum(n, d = 2) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function fmtMoney(n, ccy) {
  if (n == null || isNaN(n)) return '–';
  const sign = n < 0 ? '−' : '';
  const sym = ccy === 'KRW' ? '₩' : '$';
  return `${sign}${sym}${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
export function fmtCompact(n, ccy) {
  if (n == null || isNaN(n)) return '–';
  const sym = ccy === 'KRW' ? '₩' : '$';
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}K` : a.toFixed(0);
  return `${n < 0 ? '−' : ''}${sym}${s}`;
}
export const cls = n => (n == null ? '' : n > 0 ? 'up' : n < 0 ? 'down' : '');
// Text colour by sign; a flat holding (cash) stays neutral rather than reading as a gain.
export const signColor = n => (Math.abs(n) < 5e-4 ? DIM : n < 0 ? RED : GREEN);

// % change after a holding's "after" bar, coloured by direction.
export function HoldingPctLabel({ x, y, width, height, value }) {
  if (value == null) return null;
  return (
    <text x={x + width + 6} y={y + height / 2} dy={4} fill={signColor(value)} fontSize={11}>
      {fmtPct(value)}
    </text>
  );
}

// Portfolio name on a chart axis, as a link to that portfolio's page. The axis is keyed by
// id (names needn't be unique), so the label is looked up here.
export function PortfolioTick({ x, y, payload, nameById, onOpen }) {
  const name = nameById.get(payload.value) || '';
  const short = name.length > 16 ? `${name.slice(0, 15).trimEnd()}…` : name;
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fill={ACCENT} fontSize={12} style={{ cursor: 'pointer' }}
      onClick={e => { e.stopPropagation(); onOpen(payload.value); }}>
      <title>Open {name}</title>
      {short}
    </text>
  );
}

// "Show: All None | each portfolio" toggles. `hidden` is a Set of excluded ids, tracked
// as exclusions so a newly created portfolio shows up by default.
export function PortfolioChips({ portfolios, hidden, setHidden }) {
  const toggle = id => setHidden(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
      <span style={{ ...dimLabel, marginRight: 4 }}>Show</span>
      <button className="btn ghost" style={chipStyle} onClick={() => setHidden(new Set())}>All</button>
      <button className="btn ghost" style={chipStyle} onClick={() => setHidden(new Set(portfolios.map(p => p.id)))}>None</button>
      <span style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 4px' }} />
      {portfolios.map(p => {
        const on = !hidden.has(p.id);
        return (
          <button key={p.id} className={`btn ${on ? '' : 'ghost'}`} style={chipStyle} aria-pressed={on} onClick={() => toggle(p.id)}>
            {p.name}
          </button>
        );
      })}
    </div>
  );
}
