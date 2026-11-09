import { Fragment, useEffect, useState } from 'react';
import { KO } from './i18n/ko.js';

/**
 * English / Korean UI text. Every user-facing string is written in English and passed
 * through t(), which returns the Korean in i18n/ko.js when Korean is selected and the
 * English otherwise, so a string missing from the table still shows, in English.
 *
 * t() reads a module-level language rather than a React context, so it works anywhere a
 * string is built: components, helpers, chart formatters. Switching language remounts the
 * tree under LanguageProvider (keyed on the language), so everything re-renders with it.
 *
 * Placeholders: t('Data as of {date}', { date }) fills {date} in either language.
 * Paragraphs with inline markup (bold, links, colored spans) are written out in both
 * languages instead: {isKo() ? <>…</> : <>…</>}.
 */

const STORAGE_KEY = 'lang';
export const LANGS = ['en', 'ko'];

function storedLang() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return LANGS.includes(v) ? v : 'en';
  } catch {
    return 'en';
  }
}

let current = storedLang();

export function getLang() {
  return current;
}

export function isKo() {
  return current === 'ko';
}

/** Locale for dates and month names: Korean when Korean is selected, else US English. */
export function locale() {
  return current === 'ko' ? 'ko-KR' : 'en-US';
}

export function t(text, vars) {
  const s = (current === 'ko' && KO[text]) || text;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)) : s;
}

let setLangState = null;

export function setLang(lang) {
  if (!LANGS.includes(lang) || lang === current) return;
  current = lang;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* per-viewer convenience only */ }
  setLangState?.(lang);
}

export function LanguageProvider({ children }) {
  const [lang, setState] = useState(current);
  useEffect(() => {
    setLangState = setState;
    return () => { setLangState = null; };
  }, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  return <Fragment key={lang}>{children}</Fragment>;
}

/** Header toggle: shows the language you'd switch to. */
export function LanguageToggle() {
  const next = current === 'ko' ? 'en' : 'ko';
  return (
    <button
      className="btn ghost lang-toggle"
      onClick={() => setLang(next)}
      title={next === 'ko' ? 'Show the app in Korean' : '영어로 보기'}
      lang={next}
    >
      {next === 'ko' ? '한국어' : 'English'}
    </button>
  );
}
