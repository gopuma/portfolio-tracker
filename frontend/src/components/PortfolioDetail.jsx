import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import MptPanel from './MptPanel.jsx';
import PortfolioValueChart from './PortfolioValueChart.jsx';
import PortfolioAnalytics from './PortfolioAnalytics.jsx';

function fmtNum(n, d = 2) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtMoney(n, ccy, d = 0) {
  if (n == null || isNaN(n)) return '–';
  return `${Number(n).toLocaleString(undefined, { maximumFractionDigits: d })} ${ccy || ''}`.trim();
}
function fmtPct(n, d = 1) {
  if (n == null || isNaN(n)) return '–';
  return `${(Number(n) * 100).toFixed(d)}%`;
}
const cls = n => (n == null ? '' : n > 0 ? 'up' : n < 0 ? 'down' : '');
// Cash equivalents are holdings with the reserved symbol CASH:<CCY> (no instrument).
const isCash = s => typeof s === 'string' && s.startsWith('CASH:');
const cashCcy = s => (s || '').slice(5);
const CASH_CURRENCIES = ['USD', 'KRW'];
// Convert a native-currency amount into the portfolio base currency (mirrors the
// backend's convert()) so KRW holdings (e.g. the KRX gold spot) read in dollars.
function toBase(amount, currency, base, krwPerUsd) {
  if (amount == null) return null;
  if (currency === base || !krwPerUsd) return amount;
  if (base === 'USD' && currency === 'KRW') return amount / krwPerUsd;
  if (base === 'KRW' && currency === 'USD') return amount * krwPerUsd;
  return amount;
}
const field = { background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '6px 8px', fontSize: 13 };
// Subtle cue that a value is double-click editable.
const editableHint = { borderBottom: '1px dashed var(--text-dim)', paddingBottom: 1 };

export default function PortfolioDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [removeMode, setRemoveMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [editShareId, setEditShareId] = useState(null);
  const [shareDraft, setShareDraft] = useState('');
  const [editCostId, setEditCostId] = useState(null);
  const [costDraft, setCostDraft] = useState('');
  const [editAccountId, setEditAccountId] = useState(null);
  const [accountDraft, setAccountDraft] = useState('');
  const [mptOpen, setMptOpen] = useState(false);
  const [sortKey, setSortKey] = useState(null);  // column to sort holdings by
  const [sortDir, setSortDir] = useState('asc'); // 'asc' | 'desc'
  const [ver, setVer] = useState(0);             // bumped on every reload so the value chart refetches after edits

  const load = () => api.portfolioById(id).then(d => { setData(d); setVer(v => v + 1); }).catch(e => setErr(e.message));
  useEffect(() => { setLoading(true); load().finally(() => setLoading(false)); /* eslint-disable-next-line */ }, [id]);

  const deletePortfolio = async () => {
    if (!window.confirm(`Delete portfolio "${data?.name}" and all its holdings? This cannot be undone.`)) return;
    try { await api.deletePortfolio(id); navigate('/portfolios'); }
    catch (e) { window.alert(`Failed to delete: ${e.message}`); }
  };

  const startRename = () => { setNameDraft(data.name); setEditingName(true); };
  const saveName = async () => {
    const n = nameDraft.trim();
    setEditingName(false);
    if (!n || n === data.name) return;
    try { await api.renamePortfolio(id, n); load(); }
    catch (e) { window.alert(`Rename failed: ${e.message}`); }
  };

  if (loading) return <div className="loading">Loading portfolio…</div>;
  if (err) return <div className="error">Failed to load: {err}</div>;
  if (!data) return null;

  const t = data.totals;
  const ccy = data.base_currency;
  // Show the securities/cash split on the value & cost cards only when cash is held.
  const hasCash = (t.cash_value || 0) > 0;
  // Cash doesn't count toward the securities cap.
  const securityCount = data.holdings.filter(h => !isCash(h.symbol)).length;
  const full = securityCount >= data.max_holdings;
  const hasHoldings = data.holdings.length > 0;

  // Won-denominated mirror of the value totals (shown only for non-KRW portfolios).
  const krwPerUsd = data.krw_per_usd;
  const toKrw = (v) => (v == null ? null : ccy === 'KRW' ? v : (krwPerUsd ? v * krwPerUsd : null));
  const showKrwCards = ccy !== 'KRW' && krwPerUsd != null;

  // MPT optimizes over distinct instruments, so collapse multiple lots of the
  // same symbol into one, summing their weights. Cash is excluded (not tradable).
  const mptWeights = {};
  for (const h of data.holdings) {
    if (isCash(h.symbol)) continue;
    mptWeights[h.symbol] = (mptWeights[h.symbol] || 0) + (h.weight || 0);
  }
  const mptSymbols = Object.keys(mptWeights);

  // Click a header to sort by that column; click again to flip direction.
  const onSort = (key) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };
  const sortedHoldings = (() => {
    if (!sortKey) return data.holdings;
    const dir = sortDir === 'asc' ? 1 : -1;
    const isBlank = v => v == null || v === '' || (typeof v === 'number' && isNaN(v));
    return [...data.holdings].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      // Always sort blanks/nulls to the bottom, regardless of direction.
      if (isBlank(av) && isBlank(bv)) return 0;
      if (isBlank(av)) return 1;
      if (isBlank(bv)) return -1;
      if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * dir;
      return (av - bv) * dir;
    });
  })();

  const exitRemoveMode = () => { setRemoveMode(false); setSelected(new Set()); };
  const toggle = (hid) => setSelected(prev => {
    const n = new Set(prev);
    n.has(hid) ? n.delete(hid) : n.add(hid);
    return n;
  });
  const allSelected = hasHoldings && data.holdings.every(h => selected.has(h.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(data.holdings.map(h => h.id)));

  const startEditShares = (h) => { setEditShareId(h.id); setShareDraft(String(h.shares)); };
  const saveShares = async (h) => {
    const n = Number(shareDraft);
    setEditShareId(null);
    if (!(n > 0) || n === Number(h.shares)) return;
    try { await api.updateHolding(id, h.id, { shares: n }); load(); }
    catch (e) { window.alert(`Update failed: ${e.message}`); }
  };

  const startEditCost = (h) => { setEditCostId(h.id); setCostDraft(String(h.cost_price)); };
  const saveCost = async (h) => {
    const n = Number(costDraft);
    setEditCostId(null);
    if (!(n > 0) || n === Number(h.cost_price)) return;
    try { await api.updateHolding(id, h.id, { cost_price: n }); load(); }
    catch (e) { window.alert(`Update failed: ${e.message}`); }
  };

  const startEditAccount = (h) => { setEditAccountId(h.id); setAccountDraft(h.account || ''); };
  const saveAccount = async (h) => {
    const v = accountDraft.trim();
    setEditAccountId(null);
    if (v === (h.account || '')) return; // unchanged (account may legitimately be blank)
    try { await api.updateHolding(id, h.id, { account: v }); load(); }
    catch (e) { window.alert(`Update failed: ${e.message}`); }
  };

  const removeSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    const syms = data.holdings.filter(h => selected.has(h.id)).map(h => h.symbol);
    if (!window.confirm(`Remove ${ids.length} holding${ids.length > 1 ? 's' : ''} (${syms.join(', ')}) from this portfolio?`)) return;
    try { await Promise.all(ids.map(hid => api.removeHolding(id, hid))); }
    catch (e) { window.alert(`Some removals failed: ${e.message}`); }
    finally { exitRemoveMode(); load(); }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <Link to="/portfolios">← Portfolios</Link>
          {editingName ? (
            <input
              autoFocus
              value={nameDraft}
              onChange={e => setNameDraft(e.target.value)}
              onBlur={saveName}
              onKeyDown={e => { if (e.key === 'Enter') saveName(); else if (e.key === 'Escape') setEditingName(false); }}
              style={{ margin: '8px 0 0', fontSize: 28, fontWeight: 600, background: 'var(--panel-2)', border: '1px solid var(--accent)', borderRadius: 6, color: 'var(--text)', padding: '2px 8px', width: 'min(420px, 80vw)' }}
            />
          ) : (
            <h1 style={{ margin: '8px 0 0', cursor: 'text' }} onDoubleClick={startRename} title="Double-click to rename">
              {data.name}
            </h1>
          )}
          <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 4 }}>
            Base currency {ccy} · {securityCount}/{data.max_holdings} holdings
            {data.krw_per_usd ? <> · USD/KRW {fmtNum(data.krw_per_usd)}</> : null}
          </div>
        </div>
        <button
          className="btn ghost"
          onClick={deletePortfolio}
          disabled={hasHoldings}
          title={hasHoldings ? 'Remove all holdings first to delete this portfolio' : 'Delete this portfolio'}
          style={hasHoldings
            ? { color: 'var(--text-dim)', borderColor: 'var(--border)', cursor: 'not-allowed' }
            : { color: 'var(--red)', borderColor: 'var(--red)' }}
        >
          Delete portfolio
        </button>
      </div>

      <div className="grid-5">
        <Metric
          label="Market Value" value={fmtMoney(t.market_value, ccy)}
          sub={hasCash && <SecCashSub securities={t.securities_value} cash={t.cash_value} ccy={ccy} fmt={fmtMoney} />}
        />
        <Metric
          label="Cost Basis" value={fmtMoney(t.cost_basis, ccy)}
          sub={hasCash && <SecCashSub securities={t.securities_cost} cash={t.cash_value} ccy={ccy} fmt={fmtMoney} />}
        />
        <Metric label="Total Gain" value={fmtMoney(t.gain, ccy)} color={cls(t.gain)} />
        <Metric
          label="Inception" value={fmtPct(t.return_inception)} color={cls(t.return_inception)}
          sub={hasCash && <CashInclSub value={t.return_inception_with_cash} />}
        />
        <Metric
          label="YTD" value={fmtPct(t.return_ytd)} color={cls(t.return_ytd)}
          sub={hasCash && <CashInclSub value={t.return_ytd_with_cash} />}
        />
      </div>

      {showKrwCards && (
        <div className="grid-3" style={{ marginTop: 16 }}>
          <Metric
            label="Market Value (KRW)" value={fmtMoney(toKrw(t.market_value), 'KRW')}
            sub={hasCash && <SecCashSub securities={toKrw(t.securities_value)} cash={toKrw(t.cash_value)} ccy="KRW" fmt={fmtMoney} />}
          />
          <Metric
            label="Cost Basis (KRW)" value={fmtMoney(toKrw(t.cost_basis), 'KRW')}
            sub={hasCash && <SecCashSub securities={toKrw(t.securities_cost)} cash={toKrw(t.cash_value)} ccy="KRW" fmt={fmtMoney} />}
          />
          <Metric label="Total Gain (KRW)" value={fmtMoney(toKrw(t.gain), 'KRW')} color={cls(t.gain)} />
        </div>
      )}

      {hasHoldings && <PortfolioValueChart portfolioId={id} base={ccy} reloadKey={ver} />}

      <AddHoldingForm portfolioId={id} full={full} onAdded={load} />

      <AddCashForm portfolioId={id} onAdded={load} />

      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Holdings</h2>
          {hasHoldings && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {!removeMode ? (
                <button className="btn ghost" onClick={() => setRemoveMode(true)} style={{ color: 'var(--red)', borderColor: 'var(--red)' }}>
                  Remove
                </button>
              ) : (
                <>
                  <button className="btn" onClick={removeSelected} disabled={selected.size === 0} style={{ background: 'var(--red)' }}>
                    Remove selected ({selected.size})
                  </button>
                  <button className="btn ghost" onClick={exitRemoveMode}>Cancel</button>
                </>
              )}
            </div>
          )}
        </div>
        {data.holdings.length === 0 ? (
          <div className="loading">No holdings yet — register a ticker above.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  {removeMode && (
                    <th style={{ width: 28 }}>
                      <input type="checkbox" checked={allSelected} onChange={toggleAll} title="Select all" style={{ cursor: 'pointer', width: 18, height: 18 }} />
                    </th>
                  )}
                  <SortTh label="Symbol" col="symbol" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortTh label="Account *" col="account" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortTh label="Shares *" col="shares" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortTh label="Cost *" col="cost_price" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortTh label="Last Close" col="latest_close" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortTh label={`Value (${ccy})`} col="market_value_base" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortTh label="Weight" col="weight" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortTh label="Inception" col="return_inception" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortTh label="1Y" col="return_1y" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortTh label="3Y" col="return_3y" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortTh label="5Y" col="return_5y" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                </tr>
              </thead>
              <tbody>
                {sortedHoldings.map(h => (
                  <tr key={h.id} style={removeMode && selected.has(h.id) ? { background: 'var(--panel-2)' } : undefined}>
                    {removeMode && (
                      <td>
                        <input type="checkbox" checked={selected.has(h.id)} onChange={() => toggle(h.id)} title={`Select ${h.symbol}`} style={{ cursor: 'pointer', width: 18, height: 18 }} />
                      </td>
                    )}
                    <td>
                      {isCash(h.symbol) ? (
                        <>
                          <span>💵 Cash</span>
                          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{cashCcy(h.symbol)}</div>
                        </>
                      ) : (
                        <>
                          <Link to={`/instruments/${encodeURIComponent(h.symbol)}`}>{h.symbol}</Link>
                          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{h.display_name}</div>
                        </>
                      )}
                    </td>
                    <td
                      onDoubleClick={() => !removeMode && startEditAccount(h)}
                      title={removeMode ? undefined : 'Double-click to edit account'}
                      style={removeMode ? { fontSize: 12 } : { cursor: 'pointer', fontSize: 12 }}
                    >
                      {editAccountId === h.id ? (
                        <input
                          autoFocus
                          type="text"
                          maxLength={64}
                          value={accountDraft}
                          onChange={e => setAccountDraft(e.target.value)}
                          onBlur={() => saveAccount(h)}
                          onKeyDown={e => { if (e.key === 'Enter') saveAccount(h); else if (e.key === 'Escape') setEditAccountId(null); }}
                          placeholder="e.g. Roth"
                          style={{ ...field, width: 120 }}
                        />
                      ) : (
                        <span style={{ ...editableHint, color: h.account ? 'var(--text)' : 'var(--text-dim)' }}>{h.account || '—'}</span>
                      )}
                    </td>
                    <td
                      className="num"
                      onDoubleClick={() => !removeMode && startEditShares(h)}
                      title={removeMode ? undefined : 'Double-click to edit shares'}
                      style={removeMode ? undefined : { cursor: 'pointer' }}
                    >
                      {editShareId === h.id ? (
                        <input
                          autoFocus
                          type="number"
                          min="0"
                          step="any"
                          value={shareDraft}
                          onChange={e => setShareDraft(e.target.value)}
                          onBlur={() => saveShares(h)}
                          onKeyDown={e => { if (e.key === 'Enter') saveShares(h); else if (e.key === 'Escape') setEditShareId(null); }}
                          style={{ ...field, width: 90, textAlign: 'right' }}
                        />
                      ) : (
                        <span style={editableHint}>{fmtNum(h.shares, 0)}</span>
                      )}
                    </td>
                    <td
                      className="num"
                      onDoubleClick={() => !removeMode && !isCash(h.symbol) && startEditCost(h)}
                      title={removeMode || isCash(h.symbol) ? undefined : 'Double-click to edit cost basis'}
                      style={removeMode || isCash(h.symbol) ? undefined : { cursor: 'pointer' }}
                    >
                      {isCash(h.symbol) ? (
                        <span style={{ color: 'var(--text-dim)' }}>—</span>
                      ) : editCostId === h.id ? (
                        <input
                          autoFocus
                          type="number"
                          min="0"
                          step="any"
                          value={costDraft}
                          onChange={e => setCostDraft(e.target.value)}
                          onBlur={() => saveCost(h)}
                          onKeyDown={e => { if (e.key === 'Enter') saveCost(h); else if (e.key === 'Escape') setEditCostId(null); }}
                          style={{ ...field, width: 100, textAlign: 'right' }}
                        />
                      ) : (
                        <>
                          <span style={editableHint}>{fmtNum(h.cost_price)}</span> <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{h.currency}</span>
                          {h.currency !== ccy && h.cost_price != null && data.krw_per_usd && (
                            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>≈ {fmtMoney(toBase(h.cost_price, h.currency, ccy, data.krw_per_usd), ccy, 2)}</div>
                          )}
                        </>
                      )}
                    </td>
                    <td className="num">
                      {isCash(h.symbol) ? (
                        <span style={{ color: 'var(--text-dim)' }}>—</span>
                      ) : (
                        <>
                          {fmtNum(h.latest_close)}
                          {h.currency !== ccy && h.latest_close != null && data.krw_per_usd && (
                            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>≈ {fmtMoney(toBase(h.latest_close, h.currency, ccy, data.krw_per_usd), ccy, 2)}</div>
                          )}
                        </>
                      )}
                    </td>
                    <td className="num">{fmtMoney(h.market_value_base, ccy)}</td>
                    <td className="num">{fmtPct(h.weight, 0)}</td>
                    <td className={`num ${cls(h.return_inception)}`}>{isCash(h.symbol) ? <span style={{ color: 'var(--text-dim)' }}>—</span> : fmtPct(h.return_inception)}</td>
                    <td className={`num ${cls(h.return_1y)}`}>{fmtPct(h.return_1y)}</td>
                    <td className={`num ${cls(h.return_3y)}`}>{fmtPct(h.return_3y)}</td>
                    <td className={`num ${cls(h.return_5y)}`}>{fmtPct(h.return_5y)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 12, marginBottom: 0 }}>
              * can be edited by double clicking
            </p>
          </div>
        )}
        {mptSymbols.length >= 2 && (mptOpen ? (
          <MptPanel
            symbols={mptSymbols}
            currentWeights={mptWeights}
            onClose={() => setMptOpen(false)}
          />
        ) : (
          <div style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => setMptOpen(true)}>✦ Suggest optimal allocation (MPT)</button>
          </div>
        ))}
      </div>

      {hasHoldings && (
        <PortfolioAnalytics
          portfolioId={id}
          nameBySym={Object.fromEntries(data.holdings.map(h => [h.symbol, h.display_name]))}
          reloadKey={ver}
        />
      )}
    </>
  );
}

function Metric({ label, value, color, sub }) {
  return (
    <div className="panel">
      <div className="metric-label">{label}</div>
      <div className={`metric ${color || ''}`} style={{ fontSize: 20 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.5 }}>{sub}</div>}
    </div>
  );
}

// Cash-inclusive return shown beneath the securities-only headline on the YTD /
// Inception cards — larger and color-coded so it stands out as a secondary figure.
function CashInclSub({ value }) {
  return (
    <span style={{ marginTop: 2, display: 'inline-block' }}>
      <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>incl. cash </span>
      <span className={cls(value)} style={{ fontSize: 13, fontWeight: 600 }}>{fmtPct(value)}</span>
    </span>
  );
}

// Breakdown sub-line for the value/cost cards: securities vs. cash, in the given currency.
function SecCashSub({ securities, cash, ccy, fmt }) {
  return (
    <>
      <div>Securities {fmt(securities, ccy)}</div>
      <div>Cash <span style={{ color: 'var(--text)' }}>{fmt(cash, ccy)}</span></div>
    </>
  );
}

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

// Register a ticker by searching for it by name or symbol, picking a match, then
// entering volume. Price auto-fills with the latest close but can be overridden.
function AddHoldingForm({ portfolioId, full, onAdded }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [focused, setFocused] = useState(false); // search box has focus
  const [selected, setSelected] = useState(null); // { symbol, name }
  const [meta, setMeta] = useState(null);          // { currency, price }
  const [metaLoading, setMetaLoading] = useState(false);
  const [shares, setShares] = useState('');
  const [price, setPrice] = useState('');
  const [account, setAccount] = useState(''); // optional label so the same ticker can be added per account
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(null);
  const [highlight, setHighlight] = useState(0); // keyboard-highlighted result index
  const activeRef = useRef(null);

  // Debounced name/symbol search (skips once a stock is selected).
  useEffect(() => {
    if (selected || query.trim().length < 2) { setResults([]); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      api.searchSymbols(query.trim())
        .then(r => { if (!cancelled) { setResults(r.results || []); setShowResults(true); setHighlight(0); } })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, selected]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest' }); }, [highlight]);

  // Arrow keys navigate the dropdown; Enter picks; Escape closes.
  const onSearchKeyDown = (e) => {
    if (!showResults || results.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const r = results[highlight]; if (r) choose(r); }
    else if (e.key === 'Escape') { e.preventDefault(); setShowResults(false); }
  };

  const choose = async (r) => {
    setSelected(r);
    setResults([]); setShowResults(false); setErr(null); setOk(null);
    setMetaLoading(true); setMeta(null); setPrice('');
    try {
      const m = await api.lookup(r.symbol);
      setMeta(m);
      if (m.price != null) setPrice(String(m.price)); // auto-fill latest close
    } catch {
      setMeta(null);
    } finally {
      setMetaLoading(false);
    }
  };

  const clearSelection = () => { setSelected(null); setMeta(null); setQuery(''); setShares(''); setPrice(''); setAccount(''); setErr(null); };

  const submit = async (e) => {
    e?.preventDefault();
    const sh = Number(shares);
    if (!selected || !(sh > 0)) { setErr('Pick a stock and enter a positive volume'); return; }
    setBusy(true); setErr(null); setOk(null);
    try {
      const body = { symbol: selected.symbol, shares: sh };
      if (price !== '' && Number(price) > 0) body.price = Number(price);
      if (account.trim()) body.account = account.trim();
      const r = await api.addHolding(portfolioId, body);
      setOk(`Added ${r.symbol}${r.account ? ` (${r.account})` : ''} — ${fmtNum(r.shares, 0)} @ ${fmtNum(r.cost_price)} ${r.currency}`);
      setSelected(null); setMeta(null); setQuery(''); setShares(''); setPrice(''); setAccount('');
      onAdded?.();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>Register a Ticker</h2>
      {full ? (
        <div style={{ color: 'var(--amber)', fontSize: 13 }}>This portfolio is full (max 30 holdings). Remove one to add another.</div>
      ) : !selected ? (
        // Step 1 — search by name or symbol, pick a match.
        <div style={{ position: 'relative', maxWidth: 460 }}>
          <div className="metric-label" style={{ marginBottom: 4 }}>Search by name or symbol</div>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onFocus={() => { setFocused(true); if (results.length) setShowResults(true); }}
            // Delay so a click on a result registers before the dropdown/indicator hides.
            onBlur={() => setTimeout(() => { setFocused(false); setShowResults(false); }, 150)}
            onKeyDown={onSearchKeyDown}
            placeholder="e.g. Apple, Tesla, Samsung, ISRG…"
            style={{ ...field, width: '100%' }}
          />
          {focused && searching && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>Searching…</div>}
          {showResults && results.length > 0 && (
            <div style={{ position: 'absolute', zIndex: 10, left: 0, right: 0, marginTop: 4, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, maxHeight: 280, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
              {results.map((r, i) => (
                <button
                  key={r.symbol}
                  type="button"
                  ref={i === highlight ? activeRef : null}
                  onClick={() => choose(r)}
                  onMouseEnter={() => setHighlight(i)}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', background: i === highlight ? 'var(--panel)' : 'transparent', border: 'none', borderBottom: '1px solid var(--border)', color: 'var(--text)', padding: '8px 10px', cursor: 'pointer' }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  <span style={{ flexShrink: 0, fontSize: 11, color: 'var(--text-dim)' }}>{r.symbol} · {r.exchange}</span>
                </button>
              ))}
            </div>
          )}
          {showResults && !searching && query.trim().length >= 2 && results.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>Not found in the US or Korean markets.</div>
          )}
        </div>
      ) : (
        // Step 2 — chosen stock: enter volume and (optional) custom price.
        <form onSubmit={submit} style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <Labeled label="Selected">
            <div style={{ ...field, minWidth: 200 }}>
              <strong>{selected.symbol}</strong> <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{selected.name}</span>
            </div>
          </Labeled>
          <Labeled label="Latest Close">
            <div style={{ ...field, minWidth: 110, color: meta ? 'var(--text)' : 'var(--text-dim)' }}>
              {metaLoading ? '…' : meta?.price != null ? `${fmtNum(meta.price)} ${meta.currency || ''}` : '—'}
            </div>
          </Labeled>
          <Labeled label="Volume (shares)">
            <input autoFocus type="number" min={0} step="any" value={shares} onChange={e => setShares(e.target.value)} placeholder="0" disabled={busy} style={{ ...field, width: 110 }} />
          </Labeled>
          <Labeled label="Price (cost basis)">
            <input type="number" min={0} step="any" value={price} onChange={e => setPrice(e.target.value)} placeholder="latest close" disabled={busy} style={{ ...field, width: 130 }} />
          </Labeled>
          <Labeled label="Account (optional)">
            <input type="text" value={account} onChange={e => setAccount(e.target.value)} placeholder="e.g. Roth, 401k" disabled={busy} maxLength={64} style={{ ...field, width: 140 }} />
          </Labeled>
          <button className="btn" type="submit" disabled={busy || !(Number(shares) > 0)}>
            {busy ? 'Adding…' : 'Add holding'}
          </button>
          <button className="btn ghost" type="button" onClick={clearSelection} disabled={busy}>Change</button>
          {ok && <span style={{ fontSize: 12, color: 'var(--green)' }}>{ok}</span>}
          {err && <span style={{ fontSize: 12, color: 'var(--red)' }}>Error: {err}</span>}
        </form>
      )}
      <p style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 0, marginTop: 12, lineHeight: 1.6 }}>
        Search a company by name or symbol and pick a match. <strong style={{ color: 'var(--text)' }}>Price</strong> auto-fills with the
        latest close — leave it to use that as your cost basis, or enter a custom purchase price. Use <strong style={{ color: 'var(--text)' }}>Account</strong> to
        hold the same ticker more than once (e.g. across brokerage accounts); same ticker + same account updates the existing lot. New
        tickers are auto-tracked and backfilled (~5y) so returns work.
      </p>
    </div>
  );
}

function Labeled({ label, children }) {
  return (
    <div>
      <div className="metric-label" style={{ marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

// Add a cash equivalent (USD/KRW) as a holding. Same currency + same account edits
// the existing balance; amounts are valued 1:1 and counted in totals, weights, and
// the value chart (but excluded from return/risk analytics).
function AddCashForm({ portfolioId, onAdded }) {
  const [currency, setCurrency] = useState('USD');
  const [amount, setAmount] = useState('');
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(null);

  const submit = async (e) => {
    e?.preventDefault();
    const amt = Number(amount);
    if (!(amt > 0)) { setErr('Enter a positive amount'); return; }
    setBusy(true); setErr(null); setOk(null);
    try {
      const r = await api.addCash(portfolioId, { currency, amount: amt, account: account.trim() || undefined });
      setOk(`Added ${fmtNum(r.amount, 0)} ${r.currency}${r.account ? ` (${r.account})` : ''} cash`);
      setAmount(''); setAccount('');
      onAdded?.();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>Add Cash</h2>
      <form onSubmit={submit} style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <Labeled label="Currency">
          <select value={currency} onChange={e => setCurrency(e.target.value)} disabled={busy} style={{ ...field, width: 100 }}>
            {CASH_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </Labeled>
        <Labeled label="Amount">
          <input autoFocus type="number" min={0} step="any" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" disabled={busy} style={{ ...field, width: 140 }} />
        </Labeled>
        <Labeled label="Account (optional)">
          <input type="text" value={account} onChange={e => setAccount(e.target.value)} placeholder="e.g. Roth, 401k" disabled={busy} maxLength={64} style={{ ...field, width: 140 }} />
        </Labeled>
        <button className="btn" type="submit" disabled={busy || !(Number(amount) > 0)}>
          {busy ? 'Adding…' : 'Add cash'}
        </button>
        {ok && <span style={{ fontSize: 12, color: 'var(--green)' }}>{ok}</span>}
        {err && <span style={{ fontSize: 12, color: 'var(--red)' }}>Error: {err}</span>}
      </form>
      <p style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 0, marginTop: 12, lineHeight: 1.6 }}>
        Cash is valued 1:1 in its currency and counts toward <strong style={{ color: 'var(--text)' }}>Market Value</strong> and
        weights. Adjust a balance later by double-clicking its amount in the Holdings table; same currency + same account updates the
        existing balance. Return/risk analytics exclude cash.
      </p>
    </div>
  );
}
