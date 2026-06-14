/**
 * Loads environment variables from the project-root `.env` (one place for all
 * credentials), no matter which directory a script is launched from, then validates
 * that the required secrets are present. Import this FIRST in every entry point
 * (before db.js, which reads process.env at import time).
 *
 * There are no hardcoded credential fallbacks anywhere — if `.env` is missing the
 * app fails fast with a clear message instead of silently using a default password.
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
config({ path: path.join(rootDir, '.env') });

const REQUIRED = ['DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  throw new Error(
    `Missing required env var(s): ${missing.join(', ')}.\n` +
    `Create a .env at the project root (copy .env.example) and set them. ` +
    `See SETUP.md.`
  );
}
