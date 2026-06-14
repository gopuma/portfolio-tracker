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

export async function getInstrument(symbol) {
  const rows = await query('SELECT * FROM instruments WHERE symbol = ?', [symbol]);
  return rows[0] || null;
}

export async function getAllInstruments() {
  return query('SELECT * FROM instruments WHERE is_active = 1 ORDER BY market, symbol');
}
