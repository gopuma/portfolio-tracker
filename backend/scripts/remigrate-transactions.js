/**
 * Rebuild the transaction ledger under the "cash is manual" rule (buys/sells no longer
 * move cash). Re-seeds each portfolio from its CURRENT holdings + cash — one buy per
 * security lot (net shares @ avg cost) and one deposit per cash lot — dropping the old
 * "opening deposits" that only existed to offset the previous auto-cash behavior.
 * Per-lot trade dates are preserved from the existing transactions.
 *
 * Dry-run by default (verifies the rebuild reproduces current holdings + cash); --apply writes.
 */
import '../src/env.js';
import { query, pool } from '../src/db.js';
import { deriveState, rederivePortfolioHoldings } from '../src/services/ledgerService.js';

const isCash = s => typeof s === 'string' && s.startsWith('CASH:');
const APPLY = process.argv.includes('--apply');

async function run() {
  const portfolios = await query(`SELECT id, name, DATE_FORMAT(created_at,'%Y-%m-%d') created FROM portfolios ORDER BY id`);
  for (const p of portfolios) {
    const holdings = await query(`SELECT symbol, account, shares, cost_price, currency FROM portfolio_holdings WHERE portfolio_id = ?`, [p.id]);
    if (holdings.length === 0) { console.log(`pf=${p.id} ${p.name}: no holdings, skip`); continue; }

    // Earliest trade date per lot (preserve inception).
    const dateRows = await query(
      `SELECT symbol, account, DATE_FORMAT(MIN(trade_date),'%Y-%m-%d') d FROM transactions WHERE portfolio_id = ? GROUP BY symbol, account`, [p.id]);
    const dateByLot = new Map(dateRows.map(r => [`${r.symbol}|${r.account || ''}`, r.d]));
    const dateOf = h => dateByLot.get(`${h.symbol}|${h.account || ''}`) || p.created;

    // Plan: one buy per security lot, one deposit per (nonzero) cash lot. No opening deposits.
    const txns = [];
    for (const h of holdings) {
      const shares = Number(h.shares);
      if (Math.abs(shares) < 1e-9) continue;
      if (isCash(h.symbol)) {
        txns.push({ symbol: h.symbol, account: h.account || '', side: 'deposit', shares, price: 1, currency: h.currency, trade_date: dateOf(h) });
      } else {
        txns.push({ symbol: h.symbol, account: h.account || '', side: 'buy', shares, price: Number(h.cost_price), currency: h.currency, trade_date: dateOf(h) });
      }
    }

    // Verify: derived-from-plan matches current holdings (shares) exactly.
    const derived = deriveState(txns.map(t => ({ ...t })));
    const cur = new Map(holdings.filter(h => Math.abs(Number(h.shares)) > 1e-9).map(h => [`${h.symbol}|${h.account || ''}`, Number(h.shares)]));
    const der = new Map([...derived.holdings, ...derived.cashLots].map(h => [`${h.symbol}|${h.account || ''}`, Number(h.shares)]));
    let mismatches = 0;
    for (const [k, v] of cur) { const d = der.get(k); if (d == null || Math.abs(d - v) > 1e-3) mismatches++; }
    for (const k of der.keys()) if (!cur.has(k)) mismatches++;

    console.log(`pf=${p.id} ${p.name}: ${holdings.length} lots -> ${txns.length} txns (${txns.filter(t=>t.side==='buy').length} buys, ${txns.filter(t=>t.side==='deposit').length} deposits) | mismatches=${mismatches}`);

    if (APPLY && mismatches === 0) {
      await query(`DELETE FROM transactions WHERE portfolio_id = ?`, [p.id]);
      for (const t of txns) {
        await query(
          `INSERT INTO transactions (portfolio_id, symbol, account, side, shares, price, currency, trade_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [p.id, t.symbol, t.account, t.side, t.shares, t.price, t.currency, t.trade_date]);
      }
      await rederivePortfolioHoldings(p.id);
      console.log(`   ✓ rebuilt + re-derived`);
    } else if (APPLY) {
      console.log(`   ✗ NOT applied — ${mismatches} mismatch(es)`);
    }
  }
  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
