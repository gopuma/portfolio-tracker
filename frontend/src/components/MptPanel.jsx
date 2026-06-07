import { useEffect, useState } from 'react';
import { api } from '../api.js';

function fmtPct(n, d = 1) {
  if (n == null || isNaN(n)) return '–';
  return `${(Number(n) * 100).toFixed(d)}%`;
}
function fmtRatio(n, d = 2) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toFixed(d);
}
const cls = n => (n == null ? '' : n > 0 ? 'up' : n < 0 ? 'down' : '');

const PRESETS = [
  { label: '1Y', days: 365 },
  { label: '3Y', days: 1095 },
  { label: '5Y', days: 1825 },
];
const inputStyle = { width: 64, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '6px 8px', fontSize: 13 };

/**
 * Modern Portfolio Theory allocation for a set of symbols. Controlled: it's mounted
 * only when open and runs the optimization immediately; the Close button calls onClose.
 * Shows max-Sharpe (optimal), min-variance, and equal-weight. If `currentWeights`
 * ({symbol: weight}) is passed, adds a "Current" comparison column.
 */
export default function MptPanel({ symbols, currentWeights, title = 'Optimal Portfolio (MPT)', onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [days, setDays] = useState(365);
  const [rf, setRf] = useState(0);

  const uniq = [...new Set(symbols)];
  const symKey = uniq.join(',');

  // Re-optimize whenever the symbols, window, or risk-free rate change (debounced
  // so typing in the risk-free field updates the result without needing to blur).
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null);
    const t = setTimeout(() => {
      api.optimize(uniq, days, rf)
        .then(res => { if (!cancelled) setData(res); })
        .catch(e => { if (!cancelled) { setErr(e.message); setData(null); } })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symKey, days, rf]);

  const ms = data?.max_sharpe;

  return (
    <div className="panel" style={{ marginTop: 12, marginBottom: 4, background: 'var(--panel-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {PRESETS.map(p => (
            <button key={p.label} className={`btn ${days === p.days ? '' : 'ghost'}`} onClick={() => setDays(p.days)}>{p.label}</button>
          ))}
          <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 6 }}>Risk-free</span>
          <input type="number" step={0.5} min={0} max={20} value={(rf * 100).toString()}
            onChange={e => setRf(Math.max(0, Number(e.target.value) / 100))}
            style={inputStyle} />
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>%</span>
          <button className="btn ghost" onClick={onClose} style={{ color: 'var(--red)', borderColor: 'var(--red)', fontWeight: 600 }}>✕ Close</button>
        </div>
      </div>

      {loading ? (
        <div className="loading">Optimizing…</div>
      ) : err ? (
        <div className="error" style={{ marginTop: 10 }}>{err}</div>
      ) : data?.error ? (
        <div className="error" style={{ marginTop: 10 }}>{data.error}</div>
      ) : !data ? null : (
        <>
          <div className="grid-3" style={{ marginTop: 14 }}>
            <PortfolioStat label="★ Max Sharpe (optimal)" p={data.max_sharpe} highlight />
            <PortfolioStat label="Min Variance" p={data.min_variance} />
            <PortfolioStat label="Equal Weight" p={data.equal_weight} />
          </div>

          <div style={{ overflowX: 'auto', marginTop: 16 }}>
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="num">Exp. Return</th>
                  <th className="num">Volatility</th>
                  {currentWeights && <th className="num">Current</th>}
                  <th className="num">Suggested</th>
                  {currentWeights && <th className="num">Δ</th>}
                </tr>
              </thead>
              <tbody>
                {data.assets
                  .map(a => ({ ...a, w: ms.weights[a.symbol] ?? 0, cw: currentWeights?.[a.symbol] ?? 0 }))
                  .sort((a, b) => b.w - a.w)
                  .map(a => (
                    <tr key={a.symbol}>
                      <td>{a.symbol}</td>
                      <td className={`num ${cls(a.exp_return)}`}>{fmtPct(a.exp_return)}</td>
                      <td className="num">{fmtPct(a.vol)}</td>
                      {currentWeights && <td className="num">{fmtPct(a.cw, 0)}</td>}
                      <td className="num" style={{ fontWeight: 600 }}>{fmtPct(a.w, 0)}</td>
                      {currentWeights && <td className={`num ${cls(a.w - a.cw)}`}>{a.w - a.cw >= 0 ? '+' : ''}{fmtPct(a.w - a.cw, 0)}</td>}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 12, marginBottom: 0, lineHeight: 1.6 }}>
            Long-only weights maximizing the Sharpe ratio over {data.n_obs} overlapping days
            ({data.from_date} → {data.to_date}){data.skipped?.length ? `, excluding ${data.skipped.join(', ')} (insufficient history)` : ''}.
            Optimized from historical returns/covariance — a starting point, not advice.
          </p>
        </>
      )}
    </div>
  );
}

function PortfolioStat({ label, p, highlight }) {
  return (
    <div className="panel" style={highlight ? { borderColor: 'var(--accent)' } : undefined}>
      <div className="metric-label">{label}</div>
      <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.7 }}>
        <div>Return: <strong className={p.exp_return >= 0 ? 'up' : 'down'}>{fmtPct(p.exp_return)}</strong></div>
        <div>Volatility: <strong>{fmtPct(p.vol)}</strong></div>
        <div>Sharpe: <strong>{fmtRatio(p.sharpe)}</strong></div>
      </div>
    </div>
  );
}
