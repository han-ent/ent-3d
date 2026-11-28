import { describe, expect, it } from 'vitest';
import {
  anatomyLines,
  getLabelLang,
  LABEL_LANG_KEY,
  reloadLabelLang,
  setLabelLang,
  setLabelLangStore,
  type LabelLangStore,
} from '../src/shared/label-lang';

function memoryStore(initial?: string): LabelLangStore & { dump: () => string | null } {
  const bag = new Map<string, string>();
  if (initial) bag.set(LABEL_LANG_KEY, initial);
  return {
    getItem: (key) => bag.get(key) ?? null,
    setItem: (key, value) => {
      bag.set(key, value);
    },
    dump: () => bag.get(LABEL_LANG_KEY) ?? null,
  };
}

describe('anatomical name languages', () => {
  it('defaults to English as the main line and Korean below', () => {
    setLabelLangStore(memoryStore());
    expect(getLabelLang()).toEqual({ en: true, ko: true });
    expect(anatomyLines('Lateral rectus', '외직근')).toEqual({ main: 'Lateral rectus', sub: '외직근' });
    expect(anatomyLines('Medial longitudinal fasciculus (MLF)', '내측세로다발')).toEqual({
      main: 'Medial longitudinal fasciculus (MLF)',
      sub: '내측세로다발',
    });
  });

  it('shows one language, and Korean becomes the main line when it is the only one', () => {
    setLabelLangStore(memoryStore());
    setLabelLang({ en: true, ko: false });
    expect(anatomyLines('Lateral rectus', '외직근')).toEqual({ main: 'Lateral rectus', sub: null });
    setLabelLang({ en: false, ko: true });
    expect(anatomyLines('Lateral rectus', '외직근')).toEqual({ main: '외직근', sub: null });
  });

  it('refuses to turn both languages off and keeps the stored choice', () => {
    const store = memoryStore();
    setLabelLangStore(store);
    setLabelLang({ en: false, ko: true });
    expect(setLabelLang({ en: false, ko: false })).toEqual({ en: false, ko: true });
    expect(getLabelLang()).toEqual({ en: false, ko: true });
    expect(JSON.parse(store.dump() ?? '{}')).toEqual({ en: false, ko: true });
    setLabelLangStore(memoryStore(store.dump() ?? ''));
    reloadLabelLang();
    expect(getLabelLang()).toEqual({ en: false, ko: true });
  });
});
