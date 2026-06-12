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

// Clickable, sortable table header. Shows ▲/▼ on the active column.
function SortTh({ label, col, num, sortKey, sortDir, onSort }) {
  const active = sortKey === col;
  return (
    <th
      className={num ? 'num' : undefined}
      onClick={() => onSort(col)}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
      title="Click to sort"
    >
      {label}<span style={{ opacity: active ? 1 : 0.25, marginLeft: 4 }}>{active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
    </th>
  );
}

export default function PortfolioList() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [sortKey, setSortKey] = useState(null);  // column to sort portfolios by
  const [sortDir, setSortDir] = useState('asc'); // 'asc' | 'desc'
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

  // Click a header to sort by that column; click again to flip direction.
  const onSort = (key) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };
  const sortedPortfolios = (() => {
    const rows = data?.portfolios || [];
    if (!sortKey) return rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    const isBlank = v => v == null || v === '' || (typeof v === 'number' && isNaN(v));
    return [...rows].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      // Always sort blanks/nulls to the bottom, regardless of direction.
      if (isBlank(av) && isBlank(bv)) return 0;
      if (isBlank(av)) return 1;
      if (isBlank(bv)) return -1;
      if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * dir;
      return (av - bv) * dir;
    });
  })();

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
                  <SortTh label="Name" col="name" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortTh label="Holdings" col="holdings_count" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortTh label="Market Value" col="market_value" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortTh label="Inception" col="return_inception" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortTh label="1Y" col="return_1y" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortTh label="3Y" col="return_3y" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortTh label="5Y" col="return_5y" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortedPortfolios.map(p => (
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
