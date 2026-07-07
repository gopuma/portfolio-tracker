/**
 * One-time migration: seed the transaction ledger from current holdings, then re-derive.
 * For each portfolio with holdings but no transactions yet:
 *   - security lots  -> a `buy` at the lot's inception (current shares @ current cost),
 *                       plus a per-(currency,account) opening `deposit` = total cost so the
 *                       migrated buys stay CASH-NEUTRAL (Market Value is preserved).
 *   - cash lots      -> a `deposit` of the amount at inception.
 * Inception = earliest holding_history effective_date for that lot, else portfolio created_at.
 *
 * Dry-run by default (prints a before/after comparison); pass `--apply` to write.
 */
import '../src/env.js';
import { query, pool } from '../src/db.js';
import { deriveState, rederivePortfolioHoldings } from '../src/services/ledgerService.js';

const isCash = s => typeof s === 'string' && s.startsWith('CASH:');
const APPLY = process.argv.includes('--apply');

function planTransactions(pid, holdings, inceptionByLot, createdDate) {
  const inc = (symbol, account) => inceptionByLot.get(`${symbol}|${account || ''}`) || createdDate;
  const txns = [];
  const openingDeposits = new Map(); // `${ccy}|${acct}` -> { amount, date }

  for (const h of holdings) {
    const shares = Number(h.shares), cost = Number(h.cost_price), acct = h.account || '';
    const date = inc(h.symbol, acct);
    if (isCash(h.symbol)) {
      txns.push({ symbol: h.symbol, account: acct, side: 'deposit', shares, price: 1, currency: h.currency, trade_date: date });
    } else {
      // opening deposit accumulates this account's total cost, dated at the earliest lot
      const key = `${h.currency}|${acct}`;
      const prev = openingDeposits.get(key);
      const amt = shares * cost;
      if (!prev) openingDeposits.set(key, { amount: amt, date });
      else openingDeposits.set(key, { amount: prev.amount + amt, date: prev.date < date ? prev.date : date });
      txns.push({ symbol: h.symbol, account: acct, side: 'buy', shares, price: cost, currency: h.currency, trade_date: date });
    }
  }
  // Prepend the opening deposits (cash-neutralizing the buys).
  const opening = [...openingDeposits.entries()].map(([k, v]) => {
    const [ccy, acct] = k.split('|');
    return { symbol: `CASH:${ccy}`, account: acct, side: 'deposit', shares: v.amount, price: 1, currency: ccy, trade_date: v.date };
  });
  return [...opening, ...txns];
}

async function run() {
  const portfolios = await query(`SELECT id, name, DATE_FORMAT(created_at,'%Y-%m-%d') created FROM portfolios ORDER BY id`);
  for (const p of portfolios) {
    const [{ n: txCount }] = await query(`SELECT COUNT(*) n FROM transactions WHERE portfolio_id = ?`, [p.id]);
    const holdings = await query(`SELECT symbol, account, shares, cost_price, currency FROM portfolio_holdings WHERE portfolio_id = ?`, [p.id]);
    if (holdings.length === 0) { console.log(`pf=${p.id} ${p.name}: no holdings, skip`); continue; }
    if (Number(txCount) > 0) { console.log(`pf=${p.id} ${p.name}: already has ${txCount} transactions, skip`); continue; }

    const incRows = await query(
      `SELECT symbol, account, DATE_FORMAT(MIN(effective_date),'%Y-%m-%d') inc
         FROM holding_history WHERE portfolio_id = ? GROUP BY symbol, account`, [p.id]);
    const inceptionByLot = new Map(incRows.map(r => [`${r.symbol}|${r.account || ''}`, r.inc]));

    const txns = planTransactions(p.id, holdings, inceptionByLot, p.created);
    const derived = deriveState(txns.map(t => ({ ...t }))); // in-memory verify

    // Compare derived vs current (by symbol|account).
    const cur = new Map(holdings.map(h => [`${h.symbol}|${h.account || ''}`, Number(h.shares)]));
    const der = new Map([...derived.holdings, ...derived.cashLots].map(h => [`${h.symbol}|${h.account || ''}`, Number(h.shares)]));
    let mismatches = 0;
    for (const [k, v] of cur) { const d = der.get(k); if (d == null || Math.abs(d - v) > 1e-6) mismatches++; }
    for (const k of der.keys()) if (!cur.has(k)) mismatches++;

    console.log(`pf=${p.id} ${p.name}: ${holdings.length} lots -> ${txns.length} txns (${txns.filter(t=>t.side==='buy').length} buys, ${txns.filter(t=>t.side==='deposit').length} deposits) | mismatches=${mismatches}`);

    if (APPLY && mismatches === 0) {
      for (const t of txns) {
        await query(
          `INSERT INTO transactions (portfolio_id, symbol, account, side, shares, price, currency, trade_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [p.id, t.symbol, t.account, t.side, t.shares, t.price, t.currency, t.trade_date]
        );
      }
      await rederivePortfolioHoldings(p.id);
      console.log(`   ✓ applied + re-derived`);
    } else if (APPLY) {
      console.log(`   ✗ NOT applied — ${mismatches} mismatch(es), fix logic first`);
    }
  }
  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
