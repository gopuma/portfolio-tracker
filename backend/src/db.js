import mysql from 'mysql2/promise';

export const pool = mysql.createPool({
  // Host/port are network config (not secrets) and keep sensible local defaults.
  // Credentials have NO fallback — they must come from .env (loaded via src/env.js),
  // so a missing password fails loudly instead of silently using a known default.
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: 'Z',
  decimalNumbers: true,
});

export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/**
 * Run `fn(q)` inside one database transaction, where `q(sql, params)` has the same shape
 * as `query` but runs on the transaction's connection. Commits when `fn` resolves, rolls
 * back when it throws (the error is re-thrown), so a multi-step write lands whole or not
 * at all.
 */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  const q = async (sql, params = []) => (await conn.execute(sql, params))[0];
  try {
    await conn.beginTransaction();
    const result = await fn(q);
    await conn.commit();
    return result;
  } catch (e) {
    try { await conn.rollback(); } catch { /* connection already broken; release below */ }
    throw e;
  } finally {
    conn.release();
  }
}

export async function getInstrument(symbol) {
  const rows = await query('SELECT * FROM instruments WHERE symbol = ?', [symbol]);
  return rows[0] || null;
}

export async function getAllInstruments() {
  return query('SELECT * FROM instruments WHERE is_active = 1 ORDER BY market, symbol');
}
