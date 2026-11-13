import { useState } from 'react';
import { t } from './i18n.jsx';

/**
 * Light / dark theme for the whole app. The colours live as CSS variables in styles.css
 * (:root is dark; [data-theme="light"] overrides them), so switching is one attribute on
 * <html>. The choice is remembered per browser; with none saved, the system setting wins.
 * Applied at import (main.jsx imports this first) so the page never flashes the other theme.
 */

const STORAGE_KEY = 'theme';

function stored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function system() {
  try { return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; } catch { return 'dark'; }
}

function apply(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

let current = stored() || system();
apply(current);

export function getTheme() {
  return current;
}

/** Header toggle: shows the theme you'd switch to. */
export function ThemeToggle() {
  const [theme, setTheme] = useState(current);
  const next = theme === 'dark' ? 'light' : 'dark';
  const flip = () => {
    current = next;
    apply(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* per-viewer convenience only */ }
    setTheme(next);
  };
  return (
    <button className="btn ghost lang-toggle" onClick={flip} title={t(next === 'light' ? 'Switch to light mode' : 'Switch to dark mode')} aria-label={t(next === 'light' ? 'Switch to light mode' : 'Switch to dark mode')}>
      {next === 'light' ? '☀︎' : '☾'} {t(next === 'light' ? 'Light' : 'Dark')}
    </button>
  );
}
