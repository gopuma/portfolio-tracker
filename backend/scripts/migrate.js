/**
 * Run all SQL files in backend/src/migrations alphabetically.
 * Idempotent: each migration uses CREATE TABLE IF NOT EXISTS.
 */
import '../src/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'src', 'migrations');

async function run() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  console.log(`Running ${files.length} migration(s) from ${MIGRATIONS_DIR}`);

  const conn = await pool.getConnection();
  try {
    for (const f of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      // Split on `;` at end of line (simple but works for our schema)
      const statements = sql.split(/;\s*$/m).map(s => s.trim()).filter(Boolean);
      console.log(`→ ${f}  (${statements.length} statements)`);
      for (const stmt of statements) {
        await conn.query(stmt);
      }
    }
    console.log('Migration complete.');
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch(err => { console.error('Migration failed:', err); process.exit(1); });
