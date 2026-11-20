import type { Lang, Localized } from '../types';
import en from './en.json';
import ko from './ko.json';

const DICTS: Record<Lang, Record<string, string>> = { ko, en };

let lang: Lang = 'ko';
const listeners = new Set<() => void>();

function readStored(): Lang {
  try {
    const stored = localStorage.getItem('ent3d.lang');
    if (stored === 'en' || stored === 'ko') return stored;
  } catch {
    /* private mode */
  }
  return 'ko';
}

export function getLang(): Lang {
  return lang;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const raw = DICTS[lang][key] ?? DICTS.ko[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export function text(value: Localized | undefined): string {
  if (!value) return '';
  return value[lang] || value.ko;
}

export function setLang(next: Lang): void {
  lang = next;
  document.documentElement.lang = next === 'ko' ? 'ko' : 'en';
  try {
    localStorage.setItem('ent3d.lang', next);
  } catch {
    /* ignore */
  }
  listeners.forEach((listener) => listener());
}

export function initI18n(): void {
  setLang(readStored());
}

export function onLangChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function applyI18n(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => {
    const key = el.dataset.i18nAria;
    if (key) el.setAttribute('aria-label', t(key));
  });
}
