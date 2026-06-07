import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';

function fmtMoney(n, ccy) {
  if (n == null || isNaN(n)) return '–';
  return `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${ccy || ''}`.trim();
}
function fmtPct(n, digits = 1) {
  if (n == null || isNaN(n)) return '–';
  return `${(Number(n) * 100).toFixed(digits)}%`;
}
const cls = n => (n == null ? '' : n > 0 ? 'up' : n < 0 ? 'down' : '');

export default function PortfolioList() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const load = () => api.portfolios().then(setData).catch(e => setErr(e.message));
  useEffect(() => { load().finally(() => setLoading(false)); }, []);

  const create = async (e) => {
    e?.preventDefault();
    const n = name.trim();
    if (!n) return;
    setBusy(true); setErr(null);
    try {
      const p = await api.createPortfolio({ name: n });
      navigate(`/portfolios/${p.id}`); // segue to the new portfolio page
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id, label) => {
    if (!window.confirm(`Delete portfolio "${label}" and all its holdings?`)) return;
    try { await api.deletePortfolio(id); load(); }
    catch (e) { window.alert(`Failed: ${e.message}`); }
  };

  return (
    <>
      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>My Portfolios</h2>
          {creating ? (
            <form onSubmit={create} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                autoFocus value={name} onChange={e => setName(e.target.value)}
                placeholder="Portfolio name" disabled={busy}
                style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '6px 8px', fontSize: 13, width: 200 }}
              />
              <button className="btn" type="submit" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create'}</button>
              <button className="btn ghost" type="button" onClick={() => { setCreating(false); setName(''); }} disabled={busy}>Cancel</button>
            </form>
          ) : (
            <button className="btn" onClick={() => setCreating(true)}>+ New portfolio</button>
          )}
        </div>
        {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}
      </div>

      <div className="panel">
        {loading ? (
          <div className="loading">Loading portfolios…</div>
        ) : !data || data.count === 0 ? (
          <div className="loading">No portfolios yet — create one to start tracking returns.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Holdings</th>
                  <th className="num">Market Value</th>
                  <th className="num">Inception</th>
                  <th className="num">1Y</th>
                  <th className="num">3Y</th>
                  <th className="num">5Y</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.portfolios.map(p => (
                  <tr key={p.id}>
                    <td><Link to={`/portfolios/${p.id}`}>{p.name}</Link></td>
                    <td className="num">{p.holdings_count}</td>
                    <td className="num">{fmtMoney(p.market_value, p.base_currency)}</td>
                    <td className={`num ${cls(p.return_inception)}`}>{fmtPct(p.return_inception)}</td>
                    <td className={`num ${cls(p.return_1y)}`}>{fmtPct(p.return_1y)}</td>
                    <td className={`num ${cls(p.return_3y)}`}>{fmtPct(p.return_3y)}</td>
                    <td className={`num ${cls(p.return_5y)}`}>{fmtPct(p.return_5y)}</td>
                    <td className="num">
                      <button
                        onClick={() => remove(p.id, p.name)}
                        title={`Delete ${p.name}`}
                        style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 4px' }}
                        onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
                        onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
                      >×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 12, marginBottom: 0, lineHeight: 1.6 }}>
              <strong style={{ color: 'var(--text)' }}>Inception</strong> = current value vs. your cost basis.
              <strong style={{ color: 'var(--text)' }}> 1Y/3Y/5Y</strong> = how the current holdings would have performed over
              that trailing window, value-weighted. Values are converted to each portfolio's base currency at the latest FX rate.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
