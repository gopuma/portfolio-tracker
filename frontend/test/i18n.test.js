/**
 * Every literal string passed to t() has a Korean entry, and each entry keeps the English
 * string's {placeholders}, so switching to Korean never shows a stray English phrase or
 * an unfilled {name}.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KO } from '../src/i18n/ko.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.jsx?$/.test(e.name) ? [p] : [];
  });
}

// t('…') or t("…"), the first argument only. Handles escaped quotes inside the literal.
const CALL = /\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
const unescape = s => s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 'u' ? '\\u' : c)).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

function literals() {
  const found = new Map(); // text -> first file
  for (const file of sources(SRC)) {
    if (file.endsWith(path.join('i18n', 'ko.js'))) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(CALL)) {
      const text = unescape(m[1] ?? m[2]);
      if (text && !found.has(text)) found.set(text, path.relative(SRC, file));
    }
  }
  return found;
}

const placeholders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test('every t() string has a Korean translation', () => {
  const missing = [...literals()].filter(([text]) => !KO[text]).map(([text, file]) => `${file}: ${text}`);
  assert.deepEqual(missing, []);
});

test('Korean entries keep the English placeholders', () => {
  const wrong = Object.entries(KO)
    .filter(([en, ko]) => placeholders(en).join() !== placeholders(ko).join())
    .map(([en]) => en);
  assert.deepEqual(wrong, []);
});
