import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import AddTicker from './AddTicker.jsx';
import MptPanel from './MptPanel.jsx';

function fmtNum(n, d = 2) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtPct(n, d = 1) {
  if (n == null || isNaN(n)) return '–';
  return `${(Number(n) * 100).toFixed(d)}%`;
}
const cls = n => (n == null ? '' : n > 0 ? 'up' : n < 0 ? 'down' : '');
// Truncate long company/fund names with an ellipsis (full name stays in the title tooltip).
function truncate(s, max = 18) {
  if (!s || s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
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

// Latest close date across a set of instruments (each carrying `latest_date`).
function maxLatestDate(items) {
  const dates = (items || []).map(i => (i.latest_date || '').slice(0, 10)).filter(Boolean);
  return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
}

function sentimentPill(s) {
  if (s == null) return <span className="pill">–</span>;
  const v = Number(s);
  if (v > 0.15) return <span className="pill green">Bullish</span>;
  if (v < -0.15) return <span className="pill red">Bearish</span>;
  return <span className="pill amber">Neutral</span>;
}

const PRESETS = [
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
  { label: '3Y', days: 1095 },
  { label: '5Y', days: 1825 },
];
const MAX_DAYS = 1825;
// Period presets for the correlation matrix (independent of the stats table window).
const CORR_PRESETS = [
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
];
// Reference instruments shown on their own cards, not in the market tables.
const PROTECTED_SYMBOLS = new Set(['GC=F', 'KRX-GOLD-SPOT']);
const COLSPAN = 12; // checkbox + 11 data columns

const inputStyle = { width: 80, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '6px 8px', fontSize: 13, fontVariantNumeric: 'tabular-nums' };

function corrBg(v) {
  if (v == null) return 'transparent';
  const a = Math.min(Math.abs(v), 1) * 0.5;
  return v >= 0 ? `rgba(248,113,113,${a})` : `rgba(52,211,153,${a})`;
}

/**
 * Combined market + analytics card: one table of all watchlist stocks (US and
 * Korean, divided by a light bar) showing market data + risk/return stats, with
 * per-market MPT optimization and the correlation matrix.
 */
export default function MarketAnalytics({ instruments, reload }) {
  const [an, setAn] = useState(null);
  const [err, setErr] = useState(null);
  const [days, setDays] = useState(365);
  const [draft, setDraft] = useState('365');
  const [rf, setRf] = useState(0);
  const [removeMarket, setRemoveMarket] = useState(null); // 'US' | 'KR' | null
  const [selected, setSelected] = useState(() => new Set());
  const [mptOpen, setMptOpen] = useState({ US: false, KR: false });

  const loadAnalytics = () => api.analytics(days, rf).then(setAn).catch(e => setErr(e.message));
  useEffect(() => { loadAnalytics(); /* eslint-disable-next-line */ }, [days, rf]);

  // Correlation matrix has its own period (1D/1M/3M/6M/1Y), fetched independently
  // of the stats table window above. rf doesn't affect correlations, so omit it.
  const [corrDays, setCorrDays] = useState(365);
  const [corr, setCorr] = useState(null);     // { symbols, matrix } | null
  const [corrLoading, setCorrLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setCorrLoading(true);
    api.analytics(corrDays, 0)
      .then(d => { if (!cancelled) setCorr(d.correlation); })
      .catch(() => { if (!cancelled) setCorr(null); })
      .finally(() => { if (!cancelled) setCorrLoading(false); });
    return () => { cancelled = true; };
  }, [corrDays]);

  const onChanged = () => {
    reload?.();
    loadAnalytics();
    api.analytics(corrDays, 0).then(d => setCorr(d.correlation)).catch(() => {});
  };

  const applyDraft = () => {
    const n = Math.round(Number(draft));
    if (!n || n < 1) return;
    setDays(Math.min(n, MAX_DAYS));
  };

  const items = (instruments || []).filter(i => i.market !== 'FX' && i.market !== 'INDEX' && !PROTECTED_SYMBOLS.has(i.symbol));
  const us = items.filter(i => i.market === 'US');
  const kr = items.filter(i => i.market === 'KR');
  const statsBySym = Object.fromEntries((an?.assets || []).map(a => [a.symbol, a]));
  // Symbol → company/fund name, so the correlation matrix can show what each ticker is.
  const nameBySym = Object.fromEntries((instruments || []).map(i => [i.symbol, i.display_name]));

  const exitRemove = () => { setRemoveMarket(null); setSelected(new Set()); };
  const toggle = (sym) => setSelected(prev => { const n = new Set(prev); n.has(sym) ? n.delete(sym) : n.add(sym); return n; });
  const removeSelected = async () => {
    const syms = [...selected];
    if (syms.length === 0) return;
    if (!window.confirm(`Remove ${syms.length} ticker${syms.length > 1 ? 's' : ''} (${syms.join(', ')}) from the watchlist?`)) return;
    try { await Promise.all(syms.map(s => api.removeInstrument(s))); }
    catch (e) { window.alert(`Some removals failed: ${e.message}`); }
    finally { exitRemove(); onChanged(); }
  };

  const renderGroup = (label, rows, market) => {
    const inRemove = removeMarket === market;
    const groupSyms = rows.map(r => r.symbol);
    const allSel = groupSyms.length > 0 && groupSyms.every(s => selected.has(s));
    const barCellStyle = { background: 'var(--panel-2)', borderTop: '2px solid var(--border)' };
    const bar = (
      <tr key={`${market}-bar`}>
        <td style={{ ...barCellStyle, width: 28 }}>
          {inRemove && rows.length > 0 && (
            <input type="checkbox" checked={allSel} onChange={() => setSelected(allSel ? new Set() : new Set(groupSyms))} title="Select all" style={{ cursor: 'pointer', width: 18, height: 18 }} />
          )}
        </td>
        <td colSpan={COLSPAN - 1} style={barCellStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 12, color: 'var(--text-dim)' }}>
              {label} ({rows.length})
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {!inRemove ? (
                <>
                  <AddTicker market={market} onAdded={onChanged} />
                  {rows.length > 0 && (
                    <button className="btn ghost" style={{ color: 'var(--red)', borderColor: 'var(--red)' }} onClick={() => { setRemoveMarket(market); setSelected(new Set()); }}>
                      Remove
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button className="btn" style={{ background: 'var(--red)' }} disabled={selected.size === 0} onClick={removeSelected}>
                    Remove selected ({selected.size})
                  </button>
                  <button className="btn ghost" onClick={exitRemove}>Cancel</button>
                </>
              )}
            </div>
          </div>
        </td>
      </tr>
    );

    const dataRows = rows.map(r => {
      const s = statsBySym[r.symbol];
      const ret30 = r.return_30d;
      const pret = r.predicted_return;
      return (
        <tr key={r.symbol} style={inRemove && selected.has(r.symbol) ? { background: 'var(--panel-2)' } : undefined}>
          <td style={{ width: 28 }}>
            {inRemove && <input type="checkbox" checked={selected.has(r.symbol)} onChange={() => toggle(r.symbol)} style={{ cursor: 'pointer', width: 18, height: 18 }} />}
          </td>
          <td>
            <Link to={`/instruments/${encodeURIComponent(r.symbol)}`}>{r.symbol}</Link>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.display_name}</div>
          </td>
          <td className="num">{fmtNum(r.latest_close)} <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{r.currency}</span></td>
          <td className={`num ${cls(ret30)}`}>{fmtPct(ret30)}</td>
          <td className={`num ${cls(pret)}`}>{pret != null ? fmtPct(pret) : '–'}{r.predicted_price ? <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>→ {fmtNum(r.predicted_price)}</div> : null}</td>
          <td className="num">{r.confidence != null ? fmtPct(r.confidence, 0) : '–'}</td>
          <td>{sentimentPill(r.latest_sentiment)}</td>
          <td className={`num ${cls(s?.cagr)}`}>{fmtPct(s?.cagr)}</td>
          <td className="num">{fmtPct(s?.vol)}</td>
          <td className="num">{fmtPct(s?.downside_dev)}</td>
          <td className="num down">{fmtPct(s?.max_drawdown)}</td>
          <td className={`num ${cls(s?.sharpe)}`}>{fmtNum(s?.sharpe)}</td>
        </tr>
      );
    });

    // MPT control sits at the bottom of this market's rows: a button when closed,
    // expanding to the allocation panel (with its own Close) when open.
    const mptRow = !inRemove && groupSyms.length >= 2 ? (
      <tr key={`${market}-mpt`}>
        <td colSpan={COLSPAN} style={{ padding: '8px 0' }}>
          {mptOpen[market] ? (
            <MptPanel
              symbols={groupSyms}
              title={`Optimal ${market === 'US' ? 'US' : 'Korean'} Portfolio (MPT)`}
              onClose={() => setMptOpen(m => ({ ...m, [market]: false }))}
            />
          ) : (
            <button className="btn" onClick={() => setMptOpen(m => ({ ...m, [market]: true }))}>
              ✦ Suggest optimal allocation (MPT)
            </button>
          )}
        </td>
      </tr>
    ) : null;

    return [bar, ...dataRows, mptRow].filter(Boolean);
  };

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h2 style={{ margin: 0 }}>Portfolio Analytics</h2>
          <AsOf date={maxLatestDate(items)} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {PRESETS.map(p => (
            <button key={p.label} className={`btn ${days === p.days ? '' : 'ghost'}`} onClick={() => { setDays(p.days); setDraft(String(p.days)); }}>{p.label}</button>
          ))}
          <input type="number" min={1} max={MAX_DAYS} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') applyDraft(); }} style={inputStyle} />
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>days</span>
          <button className="btn" onClick={applyDraft}>Apply</button>
          <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-dim)' }}>Risk-free</span>
          <input type="number" step={0.5} min={0} max={20} value={(rf * 100).toString()} onChange={e => setRf(Math.max(0, Number(e.target.value) / 100))} style={{ ...inputStyle, width: 64 }} />
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>%</span>
        </div>
      </div>

      {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}

      <table style={{ marginTop: 14 }}>
        <thead>
          <tr>
            <th style={{ width: 28 }}></th>
            <th>Symbol</th>
            <th className="num">Last Close</th>
            <th className="num">30D</th>
            <th className="num">Predicted (5D)</th>
            <th className="num">Conf.</th>
            <th>Sentiment</th>
            <th className="num" title="Annualized realized return (CAGR)">Return</th>
            <th className="num" title="Annualized volatility">Vol</th>
            <th className="num" title="Annualized downside deviation">Downside</th>
            <th className="num" title="Worst peak-to-trough loss">Max DD</th>
            <th className="num" title="Return per unit of total risk">Sharpe</th>
          </tr>
        </thead>
        <tbody>
          {us.length > 0 && renderGroup('US Market', us, 'US')}
          {kr.length > 0 && renderGroup('Korean Market', kr, 'KR')}
        </tbody>
      </table>

      {/* Correlation matrix — its own period selector (1D/1M/3M/6M/1Y),
          independent of the stats table window above. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginTop: 20 }}>
        <h3 style={{ margin: 0 }}>Correlation Matrix <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(daily returns)</span></h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {CORR_PRESETS.map(p => (
            <button key={p.label} className={`btn ${corrDays === p.days ? '' : 'ghost'}`} onClick={() => setCorrDays(p.days)}>{p.label}</button>
          ))}
        </div>
      </div>

      {corrLoading ? (
        <div className="loading" style={{ marginTop: 10 }}>Loading correlations…</div>
      ) : corr?.symbols?.length > 1 ? (
        <div style={{ overflowX: 'auto', marginTop: 10 }}>
          <table style={{ fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ position: 'sticky', left: 0, background: 'var(--panel)' }}></th>
                {corr.symbols.map(s => (
                  <th key={s} className="num" title={nameBySym[s] || s} style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', whiteSpace: 'nowrap', padding: '4px 2px', verticalAlign: 'bottom' }}>
                    <span style={{ fontWeight: 600 }}>{s}</span>
                    {nameBySym[s] && (
                      <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>
                        {'  '}· {truncate(nameBySym[s], 10)}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {corr.matrix.map((row, i) => (
                <tr key={corr.symbols[i]}>
                  <th style={{ position: 'sticky', left: 0, background: 'var(--panel)', whiteSpace: 'nowrap', textAlign: 'left' }} title={nameBySym[corr.symbols[i]] || corr.symbols[i]}>
                    {corr.symbols[i]}
                    {nameBySym[corr.symbols[i]] && (
                      <div style={{ fontWeight: 400, fontSize: 10, color: 'var(--text-dim)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {nameBySym[corr.symbols[i]]}
                      </div>
                    )}
                  </th>
                  {row.map((v, j) => (
                    <td key={j} className="num" style={{ background: corrBg(v), padding: '4px 6px', textAlign: 'center' }}>{v == null ? '–' : v.toFixed(2)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="loading" style={{ marginTop: 10 }}>
          Not enough overlapping daily returns in this window to compute correlations — try a longer period.
        </div>
      )}

      <p style={{ marginTop: 12, marginBottom: 0, fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
        Market data (last close, 30D, prediction, sentiment) is current; Return/Vol/Downside/Max DD/Sharpe are computed over the
        selected window. Correlation: <span className="up">green = diversifying</span>, <span className="down">red = move together</span>.
      </p>
    </div>
  );
}
