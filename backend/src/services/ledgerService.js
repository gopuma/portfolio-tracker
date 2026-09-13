/**
 * Transaction ledger: transactions are the source of truth. Current holdings, cash
 * balances, and the value-chart composition are all DERIVED from them (average-cost).
 *
 *  - buy:      +shares to the lot; new avg cost = (oldSh·oldAvg + buySh·price)/(oldSh+buySh).
 *  - sell:     −shares; avg cost unchanged (avg-cost method).
 *  - deposit:  +amount of cash in (currency, account)  [symbol CASH:<CCY>, shares=amount, price=1]
 *  - withdraw: −amount of cash.
 *
 * Cash is managed MANUALLY via deposit/withdraw only — buys and sells do NOT move cash.
 * Cash may go negative (via withdraw) — allowed, surfaced with a warning at the route.
 */
import { query } from '../db.js';

const EPS = 1e-9;
const isCashSide = side => side === 'deposit' || side === 'withdraw';

export async function loadTransactions(portfolioId) {
  return query(
    `SELECT id, symbol, account, side, shares, price, currency,
            DATE_FORMAT(trade_date,'%Y-%m-%d') AS trade_date
       FROM transactions WHERE portfolio_id = ? ORDER BY trade_date ASC, id ASC`,
    [portfolioId]
  );
}

/**
 * Derive current securities holdings (net shares + average cost) and cash balances from a
 * portfolio's transactions (must be ordered by trade_date, id). Returns
 * { holdings:[{symbol,account,shares,cost_price,currency}], cashLots:[{symbol:'CASH:<CCY>',…}] }.
 */
export function deriveState(txns) {
  const sec = new Map();   // `${symbol}|${account}` -> { symbol, account, currency, shares, cost }
  const cash = new Map();  // `${ccy}|${account}` -> amount
  const bumpCash = (ccy, acct, delta) => {
    const k = `${ccy}|${acct}`;
    cash.set(k, (cash.get(k) || 0) + delta);
  };

  for (const t of txns) {
    const shares = Number(t.shares);
    const price = Number(t.price);
    const acct = t.account || '';

    if (isCashSide(t.side)) {
      const ccy = t.currency || (String(t.symbol).startsWith('CASH:') ? String(t.symbol).slice(5) : 'USD');
      bumpCash(ccy, acct, (t.side === 'deposit' ? 1 : -1) * shares * (price || 1));
      continue;
    }

    // buy / sell — update the lot and its cash leg.
    const k = `${t.symbol}|${acct}`;
    const h = sec.get(k) || { symbol: t.symbol, account: acct, currency: t.currency, shares: 0, cost: 0 };
    if (t.side === 'buy') {
      h.shares += shares;
      h.cost += shares * price;
    } else { // sell — reduce basis at the current average
      const avg = h.shares > EPS ? h.cost / h.shares : 0;
      h.shares -= shares;
      h.cost -= shares * avg;
    }
    h.currency = t.currency || h.currency;
    sec.set(k, h);
    // Cash is managed manually — buys/sells do not move cash.
  }

  const holdings = [];
  for (const h of sec.values()) {
    if (Math.abs(h.shares) < EPS) continue;
    holdings.push({
      symbol: h.symbol, account: h.account, shares: h.shares,
      cost_price: h.cost / h.shares, currency: h.currency,
    });
  }
  const cashLots = [];
  for (const [key, amt] of cash) {
    if (Math.abs(amt) < EPS) continue;
    const [ccy, acct] = key.split('|');
    cashLots.push({ symbol: `CASH:${ccy}`, account: acct, shares: amt, cost_price: 1, currency: ccy });
  }
  return { holdings, cashLots };
}

/**
 * Re-derive the `portfolio_holdings` cache from the ledger (called after any transaction
 * write). Existing reads (computePortfolio, analytics, MPT) keep working off this cache.
 */
export async function rederivePortfolioHoldings(portfolioId) {
  const txns = await loadTransactions(portfolioId);
  const { holdings, cashLots } = deriveState(txns);
  const all = [...holdings, ...cashLots];

  // Upsert by (portfolio_id, symbol, account) so a lot keeps a STABLE id across re-derives
  // (a DELETE+INSERT would churn ids and break the Holdings-table edit/remove, which
  // references holdings by id).
  for (const h of all) {
    await query(
      `INSERT INTO portfolio_holdings (portfolio_id, symbol, account, shares, cost_price, currency)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE shares = VALUES(shares), cost_price = VALUES(cost_price), currency = VALUES(currency)`,
      [portfolioId, h.symbol, h.account, h.shares, h.cost_price, h.currency]
    );
  }
  // Drop lots that no longer exist (fully sold / withdrawn).
  const keep = new Set(all.map(h => `${h.symbol}|${h.account}`));
  const existing = await query(`SELECT id, symbol, account FROM portfolio_holdings WHERE portfolio_id = ?`, [portfolioId]);
  for (const e of existing) {
    if (!keep.has(`${e.symbol}|${e.account || ''}`)) {
      await query(`DELETE FROM portfolio_holdings WHERE id = ?`, [e.id]);
    }
  }
  return { holdings, cashLots };
}

/**
 * Convert a portfolio's transactions into the change-log "events" the value chart consumes
 * (see walkDailyValues): one `set` per trade with the lot's CUMULATIVE shares as of its
 * trade_date (`delete` when it reaches 0). Each distinct (symbol, account) gets a stable
 * synthetic lot id.
 *
 * Cash sides are skipped unless `includeCash` — the chart is securities-only by default, so
 * an idle cash band doesn't dominate the trend. Included, a deposit/withdraw becomes a
 * running balance on the reserved `CASH:<CCY>` symbol, which the walk values at face (1)
 * in its own currency and converts like any other cross-currency lot.
 */
export function transactionsToEvents(txns, nameBySymbol = {}, instrumentIdBySymbol = {}, includeCash = false) {
  const lotId = new Map();
  const cum = new Map(); // lotKey -> running shares
  const events = [];
  for (const t of txns) {
    const cash = isCashSide(t.side);
    if (cash && !includeCash) continue;
    const key = `${t.symbol}|${t.account || ''}`;
    if (!lotId.has(key)) lotId.set(key, lotId.size + 1);
    const prev = cum.get(key) || 0;
    const sign = (t.side === 'buy' || t.side === 'deposit') ? 1 : -1;
    const next = prev + sign * Number(t.shares);
    cum.set(key, next);
    events.push({
      id: t.id,
      holding_id: lotId.get(key),
      symbol: t.symbol,
      instrument_id: cash ? null : (instrumentIdBySymbol[t.symbol] ?? null),
      currency: t.currency,
      shares: next,
      name: cash ? null : (nameBySymbol[t.symbol] || null),
      action: Math.abs(next) < EPS ? 'delete' : 'set',
      effective_date: t.trade_date,
    });
  }
  return events;
}
