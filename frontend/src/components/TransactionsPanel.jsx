import { useEffect, useState } from 'react';
import { api } from '../api.js';

function fmtNum(n, d = 2) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtMoney(n, ccy) {
  if (n == null || isNaN(n)) return '–';
  return `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${ccy || ''}`.trim();
}
const isCash = s => typeof s === 'string' && s.startsWith('CASH:');
const cashCcy = s => (s || '').slice(5);

const SIDE_COLOR = { buy: 'var(--green)', sell: 'var(--red)', deposit: 'var(--green)', withdraw: 'var(--amber)' };

/**
 * Transaction ledger for a portfolio: the source of truth. Recording buys/sells/deposits/
 * withdrawals here re-derives the holdings, cash, and value chart. `onChanged` reloads the
 * portfolio view after any write.
 */
export default function TransactionsPanel({ portfolioId, baseCurrency, onChanged }) {
  const [txns, setTxns] = useState(null);
  const [err, setErr] = useState(null);
  const [collapsed, setCollapsed] = useState(true); // long by nature — start collapsed
  const [listHeight, setListHeight] = useState(320); // drag the handle below the list to resize
  const [visible, setVisible] = useState(100);        // "show more" — render the first N rows

  const startResize = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = listHeight;
    const onMove = ev => setListHeight(Math.max(100, Math.min(1000, startH + (ev.clientY - startY))));
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const load = () => api.transactions(portfolioId).then(d => setTxns(d.transactions || [])).catch(e => setErr(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [portfolioId]);

  const [editing, setEditing] = useState(null); // { id, value } — inline price edit

  const afterWrite = () => { load(); onChanged?.(); };
  const remove = async (t) => {
    if (!window.confirm(`Delete this ${t.side} of ${isCash(t.symbol) ? cashCcy(t.symbol) : t.symbol}? Holdings and the chart will re-derive.`)) return;
    try { await api.deleteTransaction(portfolioId, t.id); afterWrite(); }
    catch (e) { window.alert(`Delete failed: ${e.message}`); }
  };
  const savePrice = async (t) => {
    const price = Number(editing?.value);
    setEditing(null);
    if (!(price > 0) || price === Number(t.price)) return; // no-op or invalid
    try { await api.updateTransaction(portfolioId, t.id, { price }); afterWrite(); }
    catch (e) { window.alert(`Update failed: ${e.message}`); }
  };

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: collapsed ? 0 : 10 }}>
        <div onClick={() => setCollapsed(c => !c)} style={{ cursor: 'pointer', userSelect: 'none', flex: 1 }} title={collapsed ? 'Expand' : 'Collapse'}>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, color: 'var(--text-dim)', width: 12 }}>{collapsed ? '▸' : '▾'}</span>
            Transactions
            {txns != null && <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-dim)' }}>({txns.length})</span>}
          </h2>
          {!collapsed && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2, marginLeft: 20 }}>The ledger — holdings, cash, and the value chart all derive from these.</div>}
        </div>
        <button className="btn ghost" onClick={() => setCollapsed(c => !c)} title={collapsed ? 'Expand' : 'Collapse'}>
          {collapsed ? '▸ Expand' : '▾ Collapse'}
        </button>
      </div>

      {!collapsed && <>
        {err && <div className="error" style={{ marginTop: 10 }}>{err}</div>}

        {txns == null ? (
          <div className="loading">Loading transactions…</div>
        ) : txns.length === 0 ? (
          <div className="loading">No transactions yet — add a holding or cash in the Holdings card above.</div>
        ) : (
          <div style={{ marginTop: 12 }}>
          <div style={{ overflow: 'auto', height: listHeight, border: '1px solid var(--border)', borderRadius: '6px 6px 0 0' }}>
            <table>
            <thead>
              <tr>
                <th>Date</th><th>Side</th><th>Symbol</th><th>Account</th>
                <th className="num">Qty / Amount</th><th className="num">Price</th><th className="num">Value</th><th></th>
              </tr>
            </thead>
            <tbody>
              {txns.slice(0, visible).map(t => {
                const cash = isCash(t.symbol);
                const value = Number(t.shares) * Number(t.price);
                return (
                  <tr key={t.id}>
                    <td>{t.trade_date}</td>
                    <td style={{ color: SIDE_COLOR[t.side], textTransform: 'capitalize', fontWeight: 600 }}>{t.side}</td>
                    <td>{cash ? `💵 ${cashCcy(t.symbol)}` : t.symbol}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-dim)' }}>{t.account || '—'}</td>
                    <td className="num">{cash ? fmtMoney(t.shares, t.currency) : fmtNum(t.shares, 0)}</td>
                    <td className="num">
                      {cash ? '—' : editing?.id === t.id ? (
                        <input
                          autoFocus
                          type="number"
                          step="any"
                          value={editing.value}
                          onChange={e => setEditing({ id: t.id, value: e.target.value })}
                          onBlur={() => savePrice(t)}
                          onKeyDown={e => { if (e.key === 'Enter') savePrice(t); if (e.key === 'Escape') setEditing(null); }}
                          style={{ width: 90, textAlign: 'right' }}
                        />
                      ) : (
                        <span
                          onClick={() => setEditing({ id: t.id, value: String(t.price) })}
                          style={{ cursor: 'pointer', borderBottom: '1px dashed var(--text-dim)' }}
                          title="Click to edit price"
                        >{fmtNum(t.price)}</span>
                      )}
                    </td>
                    <td className="num">{fmtMoney(value, t.currency)}</td>
                    <td className="num"><button className="btn ghost" style={{ color: 'var(--red)', borderColor: 'var(--red)', padding: '2px 8px' }} onClick={() => remove(t)}>✕</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          {/* Grab-to-resize handle */}
          <div
            onMouseDown={startResize}
            title="Drag to resize"
            style={{ height: 16, cursor: 'ns-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, background: 'var(--panel-2)', border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 6px 6px', userSelect: 'none' }}
          >
            <span style={{ width: 34, height: 3, borderRadius: 2, background: 'var(--text-dim)' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, fontSize: 12, color: 'var(--text-dim)' }}>
            <span>Showing {Math.min(visible, txns.length)} of {txns.length}</span>
            {txns.length > visible && (
              <>
                <button className="btn ghost" onClick={() => setVisible(v => v + 100)}>Show 100 more</button>
                <button className="btn ghost" onClick={() => setVisible(txns.length)}>Show all</button>
              </>
            )}
            {visible > 100 && txns.length > 100 && (
              <button className="btn ghost" onClick={() => setVisible(100)}>Collapse to 100</button>
            )}
          </div>
          </div>
        )}
      </>}
    </div>
  );
}
