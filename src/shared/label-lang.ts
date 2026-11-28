/**
 * Which languages anatomical names use.
 * The temporal-bone page still formats names with `englishFirst` and does not
 * read this yet. The VOR page does. Both pages can share the stored choice.
 */

export type LabelLang = { en: boolean; ko: boolean };

export const LABEL_LANG_KEY = 'ent3d.labelLang';

const BOTH: LabelLang = { en: true, ko: true };

export type LabelLangStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

type Listener = () => void;

let override: LabelLangStore | null | undefined;
let current: LabelLang = BOTH;
const listeners = new Set<Listener>();

function browserStore(): LabelLangStore | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function activeStore(): LabelLangStore | null {
  if (override !== undefined) return override;
  return browserStore();
}

function parse(raw: string | null): LabelLang | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LabelLang>;
    const en = value.en === true;
    const ko = value.ko === true;
    if (!en && !ko) return null;
    return { en, ko };
  } catch {
    return null;
  }
}

function persist(value: LabelLang): void {
  try {
    activeStore()?.setItem(LABEL_LANG_KEY, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

/** Read storage again. Tests use this after swapping the store. */
export function reloadLabelLang(): LabelLang {
  current = parse(activeStore()?.getItem(LABEL_LANG_KEY) ?? null) ?? BOTH;
  return current;
}

/**
 * Replace the backing store. `null` keeps the choice in memory only.
 * Pass `undefined` to go back to localStorage when the page has it.
 */
export function setLabelLangStore(store: LabelLangStore | null): void {
  override = store;
  reloadLabelLang();
}

export function getLabelLang(): LabelLang {
  return current;
}

/** Ignores a choice that would hide every language, and keeps the previous one. */
export function setLabelLang(next: LabelLang): LabelLang {
  if (!next.en && !next.ko) return current;
  current = { en: next.en, ko: next.ko };
  persist(current);
  listeners.forEach((listener) => listener());
  return current;
}

export function onLabelLangChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type AnatomyLines = { main: string; sub: string | null };

/**
 * Both languages: English on the main line, Korean underneath.
 * Korean only: Korean becomes the main line. English only: English alone.
 */
export function anatomyLines(nameEn: string, nameKo: string, pref: LabelLang = current): AnatomyLines {
  const en = nameEn.trim();
  const ko = nameKo.trim();
  if (pref.en && pref.ko) {
    if (!en) return { main: ko, sub: null };
    if (!ko || ko.toLowerCase() === en.toLowerCase()) return { main: en, sub: null };
    return { main: en, sub: ko };
  }
  if (pref.ko) return { main: ko || en, sub: null };
  return { main: en || ko, sub: null };
}

reloadLabelLang();
