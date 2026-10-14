import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router';
import { api } from '../api.js';
import { useLiveQuotes } from '../useLiveQuotes.js';
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
const CASH_CURRENCIES = ['USD', 'KRW', 'JPY'];
// Convert a native-currency amount into the portfolio base currency (mirrors the
// backend's convert()) so KRW holdings (e.g. the KRX gold spot) read in dollars.
// Pivots through KRW, so `rates` needs krwPerUsd, plus krwPerJpy for anything in yen.
// An unsupported currency or a missing rate returns the amount unconverted, matching
// the backend rather than silently zeroing the position.
function toBase(amount, currency, base, rates) {
  if (amount == null) return null;
  if (currency === base) return amount;
  const { krwPerUsd, krwPerJpy } = typeof rates === 'number' ? { krwPerUsd: rates } : (rates || {});
  const toKrw = (amt, ccy) => {
    if (ccy === 'KRW') return amt;
    if (ccy === 'USD') return krwPerUsd ? amt * krwPerUsd : null;
    if (ccy === 'JPY') return krwPerJpy ? amt * krwPerJpy : null;
    return null;
  };
  const fromKrw = (krw, ccy) => {
    if (krw == null) return null;
    if (ccy === 'KRW') return krw;
    if (ccy === 'USD') return krwPerUsd ? krw / krwPerUsd : null;
    if (ccy === 'JPY') return krwPerJpy ? krw / krwPerJpy : null;
    return null;
  };
  const out = fromKrw(toKrw(amount, currency), base);
  return out == null ? amount : out;
}
const field = { background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '6px 8px', fontSize: 13 };
// Subtle cue that a value is double-click editable.
const editableHint = { borderBottom: '1px dashed var(--text-dim)', paddingBottom: 1 };
// Subtle cue that a price is a live intraday quote rather than the stored close.
const liveHint = { borderBottom: '1px dotted #f5a623', paddingBottom: 1 };

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

  // Live intraday prices for the held securities. Called before the early returns below
  // so the hook order stays stable across loading/error renders. Cash has no symbol.
  const liveSymbols = (data?.holdings || []).filter(h => !isCash(h.symbol)).map(h => h.symbol);
  const { quotes: liveQuotes, err: liveErr } = useLiveQuotes(liveSymbols);

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

  const ccy = data.base_currency;
  // Won-denominated mirror of the value totals (shown only for non-KRW portfolios).
  const krwPerUsd = data.krw_per_usd;
  // Both rates, in the shape toBase() wants — krwPerJpy is only needed for yen positions.
  const fxRates = { krwPerUsd, krwPerJpy: data.krw_per_jpy };
  const toKrw = (v) => (v == null ? null : ccy === 'KRW' ? v : (krwPerUsd ? v * krwPerUsd : null));
  const showKrwCards = ccy !== 'KRW' && krwPerUsd != null;

  // ---- Live intraday overlay ------------------------------------------------
  // Swap each holding's stored close for its live quote where one exists and recompute
  // everything derived from it. Purely a view concern: nothing here is persisted, so a
  // reload falls back to the stored closes until the next scheduled refresh.
  //
  // Every stored return has the form latest/then − 1, so the window's start price is
  // latest/(1+ret). Backing that out lets the return columns follow the live price
  // exactly, without refetching the start closes. Works for values as well as prices
  // (the portfolio totals are sums of shares × price), hence the shared helper.
  const reprice = (storedRet, storedEnd, liveEnd) => {
    if (storedRet == null || storedEnd == null || liveEnd == null) return storedRet ?? null;
    const start = Number(storedEnd) / (1 + Number(storedRet));
    return start > 0 ? Number(liveEnd) / start - 1 : storedRet;
  };

  const holdings = data.holdings.map(h => {
    const q = isCash(h.symbol) ? null : liveQuotes?.[h.symbol];
    const px = q?.price;
    // No quote (synthetic symbols like KRX-GOLD-SPOT, or a failed fetch) — keep stored.
    if (px == null || !(Number(h.latest_close) > 0)) return h;
    return {
      ...h,
      latest_close: Number(px),
      market_value: Number(px) * Number(h.shares),
      market_value_base: toBase(Number(px) * Number(h.shares), h.currency, ccy, fxRates),
      return_inception: reprice(h.return_inception, h.latest_close, px),
      return_ytd: reprice(h.return_ytd, h.latest_close, px),
      return_1y: reprice(h.return_1y, h.latest_close, px),
      return_3y: reprice(h.return_3y, h.latest_close, px),
      return_5y: reprice(h.return_5y, h.latest_close, px),
      // 'REGULAR' means the market is open and this is a genuinely live tick.
      is_live: q.market_state === 'REGULAR',
      // Even when closed, the quote can be *newer* than our stored close — a session that
      // has ended but that the nightly refresh hasn't picked up yet. That still moves the
      // totals, so it has to be flagged too, or the figures shift with nothing explaining it.
      is_ahead: Number(px) !== Number(h.latest_close),
    };
  });
  const anyLive = holdings.some(h => h.is_live);
  const anyAhead = holdings.some(h => h.is_ahead);
  const overlaid = holdings.some((h, i) => h !== data.holdings[i]);

  // Recompute the totals from the overlaid holdings, mirroring the server's formulas
  // (portfolios.js) so live and stored figures never get mixed in one number. Cost basis
  // is untouched — cost doesn't move intraday.
  const st = data.totals;
  const liveValue = holdings.reduce((a, h) => a + (Number(h.market_value_base) || 0), 0);
  const liveSecValue = holdings.reduce((a, h) => a + (isCash(h.symbol) ? 0 : Number(h.market_value_base) || 0), 0);
  const t = !overlaid ? st : {
    ...st,
    market_value: liveValue,
    securities_value: liveSecValue,
    cash_value: liveValue - liveSecValue,
    gain: liveValue - st.cost_basis,
    return_inception: reprice(st.return_inception, st.securities_value, liveSecValue),
    return_ytd: reprice(st.return_ytd, st.securities_value, liveSecValue),
    return_inception_with_cash: reprice(st.return_inception_with_cash, st.market_value, liveValue),
    return_ytd_with_cash: reprice(st.return_ytd_with_cash, st.market_value, liveValue),
  };
  // Weights follow the live values so the column still sums to 100%.
  if (overlaid && liveValue > 0) {
    for (const h of holdings) h.weight = (Number(h.market_value_base) || 0) / liveValue;
  }
  // ---------------------------------------------------------------------------

  // Show the securities/cash split on the value & cost cards only when cash is held.
  const hasCash = (t.cash_value || 0) > 0;
  // Distinct account labels already used in this portfolio — offered as suggestions in the add forms.
  const accounts = [...new Set(holdings.map(h => (h.account || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  // Cash doesn't count toward the securities cap.
  const securityCount = holdings.filter(h => !isCash(h.symbol)).length;
  const full = securityCount >= data.max_holdings;
  const hasHoldings = holdings.length > 0;

  // MPT optimizes over distinct instruments, so collapse multiple lots of the
  // same symbol into one, summing their weights. Cash is excluded (not tradable).
  const mptWeights = {};
  for (const h of holdings) {
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
    if (!sortKey) return holdings;
    const dir = sortDir === 'asc' ? 1 : -1;
    const isBlank = v => v == null || v === '' || (typeof v === 'number' && isNaN(v));
    return [...holdings].sort((a, b) => {
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
  const allSelected = hasHoldings && holdings.every(h => selected.has(h.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(holdings.map(h => h.id)));

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
    const syms = holdings.filter(h => selected.has(h.id)).map(h => h.symbol);
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
            {/* Only worth the space once something is actually held in yen. */}
            {data.krw_per_jpy && data.holdings.some(h => h.currency === 'JPY')
              ? <> · JPY/KRW {fmtNum(data.krw_per_jpy)}</> : null}
          </div>
        </div>
        <button
          className="btn ghost"
          onClick={deletePortfolio}
          disabled={hasHoldings}
          title={hasHoldings ? 'Remove all holdings first to delete this portfolio' : 'Delete this portfolio'}
          style={hasHoldings
            ? { marginLeft: 'auto', color: 'var(--text-dim)', borderColor: 'var(--border)', cursor: 'not-allowed' }
            : { marginLeft: 'auto', color: 'var(--red)', borderColor: 'var(--red)' }}
        >
          Delete portfolio
        </button>
      </div>

      {/* Says why the value figures differ from the stored ones, and that nothing is saved. */}
      {(anyAhead || liveErr) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
          {anyAhead && (
            <>
              <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#f5a623' }} />
              {anyLive
                ? 'Live prices — value, gain and returns update every minute.'
                : 'Prices newer than the last stored close — markets are shut, but this session has not been saved yet.'}
              {' '}Not saved; the stored close stays the record.
            </>
          )}
          {liveErr && <span style={{ color: 'var(--red)' }}>Live quotes unavailable ({liveErr}) — showing stored closes.</span>}
        </div>
      )}

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

      <div className="panel">
        <AddHoldingForm portfolioId={id} full={full} onAdded={load} embedded accounts={accounts} holdings={holdings} />
        <AddCashForm portfolioId={id} onAdded={load} embedded accounts={accounts} />
        <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0 16px' }} />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Holdings</h2>
          {hasHoldings && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginLeft: 'auto', justifyContent: 'flex-end' }}>
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
        {holdings.length === 0 ? (
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
                  <SortTh label="Price" col="latest_close" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} title="Live while the holding's market is open (dotted underline), otherwise the last stored close" />
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
                          {h.currency !== ccy && h.cost_price != null && krwPerUsd && (
                            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>≈ {fmtMoney(toBase(h.cost_price, h.currency, ccy, fxRates), ccy, 2)}</div>
                          )}
                        </>
                      )}
                    </td>
                    <td className="num">
                      {isCash(h.symbol) ? (
                        <span style={{ color: 'var(--text-dim)' }}>—</span>
                      ) : (
                        <>
                          {h.is_ahead
                            ? <span
                                style={liveHint}
                                title={h.is_live
                                  ? 'Live price — market open. Not stored; reverts to the last close on reload.'
                                  : 'Newer than the last stored close — this session has not been saved yet. Not stored; reverts on reload.'}
                              >{fmtNum(h.latest_close)}</span>
                            : fmtNum(h.latest_close)}
                          {h.currency !== ccy && h.latest_close != null && krwPerUsd && (
                            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>≈ {fmtMoney(toBase(h.latest_close, h.currency, ccy, fxRates), ccy, 2)}</div>
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
          nameBySym={Object.fromEntries(holdings.map(h => [h.symbol, h.display_name]))}
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
function SortTh({ label, col, num, sortKey, sortDir, onSort, title }) {
  const active = sortKey === col;
  return (
    <th
      className={num ? 'num' : undefined}
      onClick={() => onSort(col)}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
      title={title ? `${title} — click to sort` : 'Click to sort'}
    >
      {label}<span style={{ opacity: active ? 1 : 0.25, marginLeft: 4 }}>{active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
    </th>
  );
}

// Register a ticker by searching for it by name or symbol, picking a match, then
// entering volume. Price auto-fills with the latest close but can be overridden.
// When the pick already exists in this portfolio under the same account, the form also
// offers to set the lot's resulting AVERAGE cost — the number a broker actually shows —
// instead of leaving it to fall out of the individual buy prices.
function AddHoldingForm({ portfolioId, full, onAdded, embedded, accounts = [], holdings = [] }) {
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
  const [avgCost, setAvgCost] = useState(''); // optional override of the lot's resulting average
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

  const clearSelection = () => { setSelected(null); setMeta(null); setQuery(''); setShares(''); setPrice(''); setAvgCost(''); setAccount(''); setErr(null); };

  // The lot this buy would land in — same ticker AND same account. Present means we're
  // adding volume to something already held, so its average cost is worth showing.
  const existingLot = selected
    ? holdings.find(h => h.symbol === selected.symbol && (h.account || '') === account.trim())
    : null;

  const submit = async (e) => {
    e?.preventDefault();
    const sh = Number(shares);
    if (!selected || !(sh > 0)) { setErr('Pick a stock and enter a positive volume'); return; }
    setBusy(true); setErr(null); setOk(null);
    try {
      const body = { symbol: selected.symbol, shares: sh };
      if (price !== '' && Number(price) > 0) body.price = Number(price);
      if (avgCost !== '' && Number(avgCost) > 0) body.avg_cost = Number(avgCost);
      if (account.trim()) body.account = account.trim();
      const r = await api.addHolding(portfolioId, body);
      setOk(`Added ${r.symbol}${r.account ? ` (${r.account})` : ''} — ${fmtNum(r.shares, 0)} @ ${fmtNum(r.cost_price)} ${r.currency}`);
      setSelected(null); setMeta(null); setQuery(''); setShares(''); setPrice(''); setAvgCost(''); setAccount('');
      onAdded?.();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={embedded ? '' : 'panel'} style={embedded ? { marginBottom: 16 } : undefined}>
      <h2 style={{ marginTop: 0 }}>Register a Ticker</h2>
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
          <Labeled label="Price paid (per share)">
            <input type="number" min={0} step="any" value={price} onChange={e => setPrice(e.target.value)} placeholder="latest close" disabled={busy} style={{ ...field, width: 130 }} />
          </Labeled>
          {/* Only meaningful when adding to a lot that already exists — otherwise the
              average is just the price paid, which the field above already sets. */}
          {existingLot && (
            <Labeled label={`Avg cost after buy (now ${fmtNum(existingLot.cost_price)})`}>
              <input
                type="number" min={0} step="any" value={avgCost}
                onChange={e => setAvgCost(e.target.value)}
                placeholder="leave blank to compute"
                title="Set the lot's average cost directly — use your broker's figure instead of letting it fall out of the individual buy prices."
                disabled={busy}
                style={{ ...field, width: 150 }}
              />
            </Labeled>
          )}
          <Labeled label="Account (optional)">
            <AccountInput value={account} onChange={setAccount} accounts={accounts} disabled={busy} />
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
        Search a company by name or symbol and pick a match. <strong style={{ color: 'var(--text)' }}>Price paid</strong> auto-fills with the
        latest close — leave it to use that as your cost basis, or enter what you actually paid. Use <strong style={{ color: 'var(--text)' }}>Account</strong> to
        hold the same ticker more than once (e.g. across brokerage accounts); same ticker + same account adds to the existing lot. When
        you're adding to a lot you already hold, <strong style={{ color: 'var(--text)' }}>Avg cost after buy</strong> lets you type your broker's
        average directly instead of letting it fall out of the individual buy prices — or leave it blank and it's computed for you. You can
        also correct any average later by double-clicking the <strong style={{ color: 'var(--text)' }}>Cost</strong> cell in the Holdings table. New
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

// Account combobox: type freely (creating a new account) or pick from the portfolio's
// existing accounts in a theme-styled dropdown (native <datalist> renders unreadable on dark).
function AccountInput({ value, onChange, accounts = [], disabled }) {
  const [open, setOpen] = useState(false);
  const matches = accounts.filter(a => a.toLowerCase().includes((value || '').toLowerCase()));
  return (
    <div style={{ position: 'relative', width: 160 }}>
      <input
        type="text" value={value} maxLength={64} disabled={disabled}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Pick or type new…"
        style={{ ...field, width: '100%' }}
      />
      {open && matches.length > 0 && (
        <div style={{ position: 'absolute', zIndex: 20, left: 0, right: 0, marginTop: 4, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, maxHeight: 200, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
          {matches.map(a => (
            <button
              key={a} type="button"
              onClick={() => { onChange(a); setOpen(false); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)', color: 'var(--text)', padding: '6px 8px', cursor: 'pointer', fontSize: 13 }}
            >
              {a}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Add a cash equivalent (USD/KRW) as a holding. Same currency + same account edits
// the existing balance; amounts are valued 1:1 and counted in totals, weights, and
// the value chart (but excluded from return/risk analytics).
function AddCashForm({ portfolioId, onAdded, embedded, accounts = [] }) {
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
    <div className={embedded ? '' : 'panel'} style={embedded ? { marginBottom: 4 } : undefined}>
      <h2 style={{ marginTop: 0 }}>Add Cash</h2>
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
          <AccountInput value={account} onChange={setAccount} accounts={accounts} disabled={busy} />
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
