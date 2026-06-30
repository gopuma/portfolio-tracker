import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

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

const PRESETS = [
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
  { label: '3Y', days: 1095 },
  { label: '5Y', days: 1825 },
];
const MAX_DAYS = 1825;

const inputStyle = { width: 80, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '6px 8px', fontSize: 13, fontVariantNumeric: 'tabular-nums' };

function corrBg(v) {
  if (v == null) return 'transparent';
  const a = Math.min(Math.abs(v), 1) * 0.5;
  return v >= 0 ? `rgba(248,113,113,${a})` : `rgba(52,211,153,${a})`;
}

/**
 * Per-portfolio analytics: a risk/return stats table over the holdings' distinct
 * instruments plus their correlation matrix, both over a selectable trailing window.
 * `nameBySym` maps symbol → display name so the correlation matrix can label tickers.
 */
export default function PortfolioAnalytics({ portfolioId, nameBySym = {}, reloadKey }) {
  const [an, setAn] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(365);
  const [draft, setDraft] = useState('365');
  const [rf, setRf] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.portfolioAnalytics(portfolioId, days, rf)
      .then(d => { if (!cancelled) { setAn(d); setErr(null); } })
      .catch(e => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [portfolioId, days, rf, reloadKey]);

  const applyDraft = () => {
    const n = Math.round(Number(draft));
    if (!n || n < 1) return;
    setDays(Math.min(n, MAX_DAYS));
  };

  const assets = an?.assets || [];
  const corr = an?.correlation;
  const name = sym => nameBySym[sym] || (assets.find(a => a.symbol === sym)?.display_name) || sym;

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Portfolio Analytics</h2>
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

      {loading ? (
        <div className="loading" style={{ marginTop: 12 }}>Loading analytics…</div>
      ) : assets.length === 0 ? (
        <div className="loading" style={{ marginTop: 12 }}>
          Not enough price history in this window to compute analytics — try a longer period.
        </div>
      ) : (
        <>
          <table style={{ marginTop: 14 }}>
            <thead>
              <tr>
                <th>Symbol</th>
                <th className="num" title="Annualized realized return (CAGR)">Return</th>
                <th className="num" title="Total return over the window">Total</th>
                <th className="num" title="Annualized volatility">Vol</th>
                <th className="num" title="Annualized downside deviation">Downside</th>
                <th className="num" title="Worst peak-to-trough loss">Max DD</th>
                <th className="num" title="Return per unit of total risk">Sharpe</th>
                <th className="num" title="Return per unit of downside risk">Sortino</th>
              </tr>
            </thead>
            <tbody>
              {assets.map(a => (
                <tr key={a.symbol}>
                  <td>
                    <Link to={`/instruments/${encodeURIComponent(a.symbol)}`}>{a.symbol}</Link>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.display_name}</div>
                  </td>
                  <td className={`num ${cls(a.cagr)}`}>{fmtPct(a.cagr)}</td>
                  <td className={`num ${cls(a.total_return)}`}>{fmtPct(a.total_return)}</td>
                  <td className="num">{fmtPct(a.vol)}</td>
                  <td className="num">{fmtPct(a.downside_dev)}</td>
                  <td className="num down">{fmtPct(a.max_drawdown)}</td>
                  <td className={`num ${cls(a.sharpe)}`}>{fmtNum(a.sharpe)}</td>
                  <td className={`num ${cls(a.sortino)}`}>{fmtNum(a.sortino)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Correlation matrix of daily returns over the same window. */}
          <h3 style={{ margin: '20px 0 0' }}>Correlation Matrix <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(daily returns)</span></h3>
          {corr?.symbols?.length > 1 ? (
            <div style={{ overflowX: 'auto', marginTop: 10 }}>
              <table style={{ fontSize: 11 }}>
                <thead>
                  <tr>
                    <th style={{ position: 'sticky', left: 0, background: 'var(--panel)' }}></th>
                    {corr.symbols.map(s => (
                      <th key={s} className="num" title={name(s)} style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', whiteSpace: 'nowrap', padding: '4px 2px', verticalAlign: 'bottom' }}>
                        <span style={{ fontWeight: 600 }}>{s}</span>
                        {name(s) !== s && (
                          <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>{'  '}· {truncate(name(s), 10)}</span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {corr.matrix.map((row, i) => (
                    <tr key={corr.symbols[i]}>
                      <th style={{ position: 'sticky', left: 0, background: 'var(--panel)', whiteSpace: 'nowrap', textAlign: 'left' }} title={name(corr.symbols[i])}>
                        {corr.symbols[i]}
                        {name(corr.symbols[i]) !== corr.symbols[i] && (
                          <div style={{ fontWeight: 400, fontSize: 10, color: 'var(--text-dim)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {name(corr.symbols[i])}
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
              Need at least two holdings with overlapping daily returns in this window to compute correlations.
            </div>
          )}

          <p style={{ marginTop: 12, marginBottom: 0, fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            Return/Vol/Downside/Max DD/Sharpe/Sortino are computed over the selected window. Correlation:{' '}
            <span className="up">green = diversifying</span>, <span className="down">red = move together</span>.
          </p>
        </>
      )}
    </div>
  );
}
