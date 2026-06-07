import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import MptPanel from './MptPanel.jsx';

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
  const [mptOpen, setMptOpen] = useState(false);

  const load = () => api.portfolioById(id).then(setData).catch(e => setErr(e.message));
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
  const full = data.holdings.length >= data.max_holdings;
  const hasHoldings = data.holdings.length > 0;

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
            Base currency {ccy} · {data.holdings.length}/{data.max_holdings} holdings
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

      <div className="grid-6">
        <Metric label="Market Value" value={fmtMoney(t.market_value, ccy)} />
        <Metric label="Cost Basis" value={fmtMoney(t.cost_basis, ccy)} />
        <Metric label="Total Gain" value={fmtMoney(t.gain, ccy)} color={cls(t.gain)} />
        <Metric label="Inception" value={fmtPct(t.return_inception)} color={cls(t.return_inception)} />
        <Metric label="1Y" value={fmtPct(t.return_1y)} color={cls(t.return_1y)} />
        <Metric label="3Y / 5Y" value={`${fmtPct(t.return_3y)} / ${fmtPct(t.return_5y)}`} />
      </div>

      <AddHoldingForm portfolioId={id} full={full} onAdded={load} />

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
                  <th>Symbol</th>
                  <th className="num">Shares *</th>
                  <th className="num">Cost *</th>
                  <th className="num">Last Close</th>
                  <th className="num">Value ({ccy})</th>
                  <th className="num">Weight</th>
                  <th className="num">Inception</th>
                  <th className="num">1Y</th>
                  <th className="num">3Y</th>
                  <th className="num">5Y</th>
                </tr>
              </thead>
              <tbody>
                {data.holdings.map(h => (
                  <tr key={h.id} style={removeMode && selected.has(h.id) ? { background: 'var(--panel-2)' } : undefined}>
                    {removeMode && (
                      <td>
                        <input type="checkbox" checked={selected.has(h.id)} onChange={() => toggle(h.id)} title={`Select ${h.symbol}`} style={{ cursor: 'pointer', width: 18, height: 18 }} />
                      </td>
                    )}
                    <td>
                      <Link to={`/instruments/${encodeURIComponent(h.symbol)}`}>{h.symbol}</Link>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{h.display_name}</div>
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
                      onDoubleClick={() => !removeMode && startEditCost(h)}
                      title={removeMode ? undefined : 'Double-click to edit cost basis'}
                      style={removeMode ? undefined : { cursor: 'pointer' }}
                    >
                      {editCostId === h.id ? (
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
                        <><span style={editableHint}>{fmtNum(h.cost_price)}</span> <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{h.currency}</span></>
                      )}
                    </td>
                    <td className="num">{fmtNum(h.latest_close)}</td>
                    <td className="num">{fmtMoney(h.market_value_base, ccy)}</td>
                    <td className="num">{fmtPct(h.weight, 0)}</td>
                    <td className={`num ${cls(h.return_inception)}`}>{fmtPct(h.return_inception)}</td>
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
        {data.holdings.length >= 2 && (mptOpen ? (
          <MptPanel
            symbols={data.holdings.map(h => h.symbol)}
            currentWeights={Object.fromEntries(data.holdings.map(h => [h.symbol, h.weight]))}
            onClose={() => setMptOpen(false)}
          />
        ) : (
          <div style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => setMptOpen(true)}>✦ Suggest optimal allocation (MPT)</button>
          </div>
        ))}
      </div>
    </>
  );
}

function Metric({ label, value, color }) {
  return (
    <div className="panel">
      <div className="metric-label">{label}</div>
      <div className={`metric ${color || ''}`} style={{ fontSize: 20 }}>{value}</div>
    </div>
  );
}

// Register a ticker by searching for it by name or symbol, picking a match, then
// entering volume. Price auto-fills with the latest close but can be overridden.
function AddHoldingForm({ portfolioId, full, onAdded }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [selected, setSelected] = useState(null); // { symbol, name }
  const [meta, setMeta] = useState(null);          // { currency, price }
  const [metaLoading, setMetaLoading] = useState(false);
  const [shares, setShares] = useState('');
  const [price, setPrice] = useState('');
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

  const clearSelection = () => { setSelected(null); setMeta(null); setQuery(''); setShares(''); setPrice(''); setErr(null); };

  const submit = async (e) => {
    e?.preventDefault();
    const sh = Number(shares);
    if (!selected || !(sh > 0)) { setErr('Pick a stock and enter a positive volume'); return; }
    setBusy(true); setErr(null); setOk(null);
    try {
      const body = { symbol: selected.symbol, shares: sh };
      if (price !== '' && Number(price) > 0) body.price = Number(price);
      const r = await api.addHolding(portfolioId, body);
      setOk(`Added ${r.symbol} — ${fmtNum(r.shares, 0)} @ ${fmtNum(r.cost_price)} ${r.currency}`);
      setSelected(null); setMeta(null); setQuery(''); setShares(''); setPrice('');
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
            onFocus={() => results.length && setShowResults(true)}
            onKeyDown={onSearchKeyDown}
            placeholder="e.g. Apple, Tesla, Samsung, ISRG…"
            style={{ ...field, width: '100%' }}
          />
          {searching && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>Searching…</div>}
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
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>No matches.</div>
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
        latest close — leave it to use that as your cost basis, or enter a custom purchase price. New tickers are auto-tracked and
        backfilled (~5y) so returns work.
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
