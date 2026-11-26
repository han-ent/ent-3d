export type SearchEntry = {
  id: string;
  kind: 'structure' | 'landmark';
  en: string;
  ko: string;
  aliases: string[];
  parentId?: string;
};

export type NamedRecord = {
  id: string;
  en: string;
  ko: string;
  parentId?: string;
};

export type TermRecord = {
  en: string;
  ko: string;
  aliases?: string[];
};

/**
 * A short synonym joins a record only when a longer name in the same group
 * already matches that record, so "round" does not hit every word.
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['cochlea', '와우', 'scala vestibuli', 'scala tympani', '전정계', '고실계'],
  ['round window', 'round', '정원창', 'fenestra cochleae', 'fenestra rotunda'],
  ['jugular bulb', 'jugular', '경정맥구'],
  ['facial recess', '안면신경와', 'facial recess'],
  ['internal auditory canal', 'internal acoustic meatus', 'iac', '내이도'],
  ['oval window', '난원창', 'fenestra vestibuli'],
  ['tympanic membrane', 'eardrum', '고막'],
  ['semicircular canal', '반고리관', 'lateral canal', '외측반고리관'],
  ['chorda tympani', '고삭신경'],
  ['promontory', '고실갑각', 'promontory'],
];

function normalize(value: string): string {
  return value.trim().toLowerCase().normalize('NFKC');
}

function applySynonyms(entry: SearchEntry): void {
  const text = normalize(`${entry.en} ${entry.ko} ${entry.id.replaceAll('-', ' ')}`);
  for (const group of SYNONYM_GROUPS) {
    const anchors = group.filter((item) => item.trim().length >= 5);
    if (!anchors.some((item) => text.includes(normalize(item)))) continue;
    for (const item of group) {
      if (!entry.aliases.some((alias) => normalize(alias) === normalize(item))) entry.aliases.push(item);
    }
  }
}

function fromTerms(entry: SearchEntry, terms: readonly TermRecord[]): void {
  const en = normalize(entry.en);
  const ko = normalize(entry.ko);
  for (const term of terms) {
    const termEn = normalize(term.en);
    const termKo = normalize(term.ko);
    const linked = (termEn && (en.includes(termEn) || termEn.includes(en))) || (termKo && ko && (ko.includes(termKo) || termKo.includes(ko)));
    if (!linked) continue;
    for (const alias of [term.en, term.ko, ...(term.aliases ?? [])]) {
      if (!alias.trim()) continue;
      if (!entry.aliases.some((item) => normalize(item) === normalize(alias))) entry.aliases.push(alias);
    }
  }
}

export function buildSearchIndex(
  structures: readonly NamedRecord[],
  landmarks: readonly NamedRecord[],
  terms: readonly TermRecord[] = [],
): SearchEntry[] {
  const entries: SearchEntry[] = [
    ...structures.map((item) => ({
      id: item.id,
      kind: 'structure' as const,
      en: item.en,
      ko: item.ko,
      aliases: [] as string[],
      parentId: item.parentId,
    })),
    ...landmarks.map((item) => ({
      id: item.id,
      kind: 'landmark' as const,
      en: item.en,
      ko: item.ko,
      aliases: [] as string[],
      parentId: item.parentId,
    })),
  ];
  for (const entry of entries) {
    fromTerms(entry, terms);
    applySynonyms(entry);
  }
  return entries;
}

export function entryMatches(entry: SearchEntry, query: string): boolean {
  const q = normalize(query);
  if (!q) return true;
  const hay = normalize([entry.id.replaceAll('-', ' '), entry.en, entry.ko, ...entry.aliases].join('\n'));
  if (hay.includes(q)) return true;
  const tokens = q.split(/\s+/).filter(Boolean);
  return tokens.length > 1 && tokens.every((token) => hay.includes(token));
}

export function searchEntries(entries: readonly SearchEntry[], query: string): SearchEntry[] {
  const q = query.trim();
  if (!q) return [];
  return entries.filter((entry) => entryMatches(entry, q));
}
