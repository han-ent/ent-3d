import type { ViewStage } from './stage-frame';

export type LabelTier = 'region' | 'structure' | 'subpart' | 'surface';

export type LabelMode = 'basic' | 'surgical' | 'all';

/** English name, then Korean, as in "Malleus 추골(망치뼈)". */
export function englishFirst(en: string, ko: string): string {
  const english = en.trim();
  const korean = ko.trim();
  if (!english) return korean;
  if (!korean || korean.toLowerCase() === english.toLowerCase()) return english;
  return `${english} ${korean}`;
}

/** One-line English that fits a phone label. The full term stays in the list and the panel. */
const SHORT_EN: Record<string, string> = {
  'Lateral semicircular canal': 'Lateral SCC',
  'Superior semicircular canal': 'Superior SCC',
  'Posterior semicircular canal': 'Posterior SCC',
  'Cochleovestibular nerve': 'Vestibulocochlear n.',
  'Sigmoid sinus / dura': 'Sigmoid sinus',
  'External auditory canal': 'Ear canal',
  'Internal auditory canal': 'IAC',
  'Basal turn (scala tympani)': 'Basal turn',
  'Middle turn (scala tympani)': 'Middle turn',
  'Apical turn (scala tympani)': 'Apical turn',
  'Basal turn (scala vestibuli)': 'Basal turn',
  'Middle turn (scala vestibuli)': 'Middle turn',
  'Apical turn (scala vestibuli)': 'Apical turn',
  'Tympanic membrane': 'Eardrum',
  'Head of malleus': 'Head',
  'Neck of malleus': 'Neck',
  'Meatal segment': 'Meatal',
  'Labyrinthine segment': 'Labyrinthine',
  'Tympanic segment': 'Tympanic',
  'Mastoid segment': 'Mastoid',
  'Geniculate ganglion': 'Geniculate',
};

/**
 * Parts that must stay labelled when that structure is selected.
 * Order is superior to inferior, which is top to bottom with the viewer's up axis.
 */
export const FOCUS_PARTS: Record<string, readonly string[]> = {
  malleus: [
    'malleus-head',
    'malleus-neck',
    'malleus-manubrium',
    'malleus-lateral-process',
    'malleus-anterior-process',
    'umbo',
  ],
  'facial-nerve': ['fn-labyrinthine', 'fn-geniculate', 'fn-tympanic', 'fn-second-genu', 'fn-mastoid'],
};

/** Named along the peel so the canal, drum, and ossicles stay labelled together. */
export const PEEL_LABELS = ['external-auditory-canal', 'tympanic-membrane', 'malleus', 'incus', 'stapes'] as const;

export function focusPartList(selected: string | null): readonly string[] | null {
  if (!selected) return null;
  if (FOCUS_PARTS[selected]) return FOCUS_PARTS[selected];
  for (const parts of Object.values(FOCUS_PARTS)) {
    if (parts.includes(selected)) return parts;
  }
  return null;
}

export function displayEnglish(en: string): string {
  const trimmed = en.trim();
  return SHORT_EN[trimmed] ?? trimmed;
}

/**
 * Preferred tiers when a view is only being thinned out.
 * This does not override the label mode. `chooseStudyLabels` uses the mode first.
 */
export function tiersForDistance(distanceMm: number): LabelTier[] {
  if (distanceMm > 60) return ['region', 'surface'];
  if (distanceMm > 20) return ['structure'];
  return ['structure', 'subpart'];
}

/** Auricle names kept on the entry view. The other surface points stay for the ear stage. */
export const BODY_SURFACE = ['helix', 'tragus', 'lobule'] as const;

export type StudyLabel = {
  id: string;
  text: string;
  en: string;
  ko: string;
  tier: LabelTier;
  modes: LabelMode[];
  priority: number;
  parentId?: string;
  /** Specimen millimetres. */
  position: [number, number, number];
  /** Crumb stages that may show this label. Empty means every stage. */
  stages?: readonly ViewStage[];
  /** Dissection steps that may show this label. */
  steps?: readonly string[];
};

function nameKey(label: StudyLabel): string {
  return `${label.en.trim().toLowerCase()}|${label.ko.trim().toLowerCase()}`;
}

function listsOverlap(a?: readonly string[], b?: readonly string[]): boolean {
  if (!a?.length || !b?.length) return true;
  return a.some((item) => b.includes(item));
}

/** Canal structures win over the arch landmark that repeats their name. */
const CANAL_STRUCTURE: Record<string, string> = {
  'scc-lateral-arch': 'scc-lateral',
  'scc-superior-arch': 'scc-superior',
  'scc-posterior-arch': 'scc-posterior',
};

function preferLabel(current: StudyLabel, incoming: StudyLabel): StudyLabel {
  if (CANAL_STRUCTURE[incoming.id] === current.id) return current;
  if (CANAL_STRUCTURE[current.id] === incoming.id) return incoming;
  const rank = (label: StudyLabel) => (label.tier === 'structure' ? 2 : label.tier === 'region' ? 0 : 1);
  if (rank(current) !== rank(incoming)) return rank(current) > rank(incoming) ? current : incoming;
  if (current.priority !== incoming.priority) return current.priority > incoming.priority ? current : incoming;
  return current.id.localeCompare(incoming.id) <= 0 ? current : incoming;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/**
 * One visible name per structure. The arch-anchored canal label is kept
 * and the landmark that repeats it is dropped. Modes and stages are merged
 * so the survivor still appears wherever either copy did.
 */
export function dedupeStudyLabels(labels: readonly StudyLabel[]): StudyLabel[] {
  const kept: StudyLabel[] = [];
  for (const label of labels) {
    const index = kept.findIndex(
      (other) =>
        (other.id === label.id || nameKey(other) === nameKey(label)) &&
        (listsOverlap(other.stages, label.stages) || listsOverlap(other.steps, label.steps)),
    );
    if (index < 0) {
      kept.push({
        ...label,
        modes: [...label.modes],
        stages: label.stages ? [...label.stages] : undefined,
        steps: label.steps ? [...label.steps] : undefined,
      });
      continue;
    }
    const other = kept[index]!;
    const winner = preferLabel(other, label);
    const stages = !other.stages?.length || !label.stages?.length ? undefined : unique([...other.stages, ...label.stages]);
    kept[index] = {
      ...winner,
      modes: unique([...other.modes, ...label.modes]),
      stages,
      steps: unique([...(other.steps ?? []), ...(label.steps ?? [])]),
      priority: Math.max(other.priority, label.priority),
      position: winner.position,
    };
  }
  return kept;
}

/** True on the frame a camera flight arrives, so labels are placed for that view. */
export function relayoutOnTweenEnd(wasTweening: boolean, stillTweening: boolean): boolean {
  return wasTweening && !stillTweening;
}

function modeIncludes(label: StudyLabel, mode: LabelMode): boolean {
  if (mode === 'all') return label.modes.includes('all') || label.modes.includes('basic') || label.modes.includes('surgical');
  return label.modes.includes(mode);
}

function contextIncludes(label: StudyLabel, stage: ViewStage | null, stepId: string | null): boolean {
  if (stepId) {
    if (label.tier === 'region') return false;
    if (label.steps?.includes(stepId)) return true;
    if (label.tier === 'subpart') return false;
    if (!label.stages || !stage) return false;
    return label.stages.includes(stage);
  }
  if (label.stages && !label.stages.includes(stage ?? 'body')) return false;
  if (stage === 'body' && label.tier === 'surface' && !BODY_SURFACE.includes(label.id as (typeof BODY_SURFACE)[number])) return false;
  return true;
}

/**
 * The selected mode decides the set. Distance does not throw that set away.
 * A basic sub-part still waits until its parent is selected.
 */
export function labelAllowed(
  label: StudyLabel,
  mode: LabelMode,
  _distanceMm: number,
  selectedParent: string | null,
  stage: ViewStage | null = null,
  stepId: string | null = null,
): boolean {
  if (!modeIncludes(label, mode)) return false;
  if (!contextIncludes(label, stage, stepId)) return false;
  if (mode === 'basic' && label.tier === 'subpart') {
    if (!selectedParent) return false;
    return label.parentId === selectedParent || label.id === selectedParent;
  }
  return true;
}

/** How many labels to keep before collision turns the rest into dots. */
export function labelBudget(mode: LabelMode, distanceMm: number): number {
  if (mode === 'surgical') return distanceMm > 220 ? 8 : distanceMm > 120 ? 14 : 22;
  if (mode === 'basic') return distanceMm > 220 ? 6 : 12;
  return distanceMm > 220 ? 8 : distanceMm > 120 ? 14 : 20;
}

/**
 * Thin a mode's own labels. Structure names are reserved so a far view
 * cannot collapse to the four group headings.
 */
export function declutterLabels(labels: readonly StudyLabel[], mode: LabelMode, distanceMm: number): StudyLabel[] {
  const budget = labelBudget(mode, distanceMm);
  const ranked = labels.slice().sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  if (ranked.length <= budget) return ranked;
  if (mode === 'surgical') return ranked.slice(0, budget);
  const primary = ranked.filter((label) => label.tier === 'structure' || label.tier === 'surface');
  const rest = ranked.filter((label) => label.tier !== 'structure' && label.tier !== 'surface');
  const reserved = Math.min(primary.length, Math.max(4, Math.ceil(budget * 0.5)));
  const ordered = [...primary.slice(0, reserved), ...rest, ...primary.slice(reserved)];
  const seen = new Set<string>();
  const picked: StudyLabel[] = [];
  for (const label of ordered) {
    if (seen.has(label.id)) continue;
    seen.add(label.id);
    picked.push(label);
    if (picked.length >= budget) break;
  }
  return picked;
}

/** How many floating names a phone can show without stacking on top of each other. */
export function phoneLabelCap(distanceMm: number): number {
  if (distanceMm > 500) return 4;
  if (distanceMm > 180) return 6;
  return 8;
}

/**
 * Far phone views keep a few coarse names. The selected structure always stays,
 * so zooming in or tapping can reveal its full label.
 */
export function thinForPhone<T extends { id: string; priority: number }>(
  labels: readonly T[],
  distanceMm: number,
  selectedId: string | null,
): T[] {
  const cap = Math.max(1, phoneLabelCap(distanceMm));
  const ranked = labels.slice().sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const picked: T[] = [];
  const seen = new Set<string>();
  const push = (label: T | undefined) => {
    if (!label || seen.has(label.id)) return;
    seen.add(label.id);
    picked.push(label);
  };
  if (selectedId) push(labels.find((label) => label.id === selectedId));
  for (const label of ranked) {
    if (picked.length >= cap) break;
    push(label);
  }
  return picked;
}

export function chooseStudyLabels(
  labels: readonly StudyLabel[],
  mode: LabelMode,
  distanceMm: number,
  selectedParent: string | null,
  stage: ViewStage | null,
  stepId: string | null,
): StudyLabel[] {
  const allowed = labels.filter((label) => labelAllowed(label, mode, distanceMm, selectedParent, stage, stepId));
  return declutterLabels(allowed, mode, distanceMm);
}

export type PlacementInput = {
  id: string;
  priority: number;
  anchorX: number;
  anchorY: number;
  width: number;
  height: number;
  occluded: boolean;
};

export type Placement = {
  id: string;
  mode: 'label' | 'dot';
  x: number;
  y: number;
  dimmed: boolean;
};

const OFFSETS: Array<[number, number]> = [
  [0, -36],
  [0, 28],
  [48, -18],
  [-48, -18],
  [36, 22],
  [-36, 22],
  [64, 4],
  [-64, 4],
  [18, -52],
  [-18, 44],
];

function overlaps(
  x: number,
  y: number,
  w: number,
  h: number,
  placed: Array<{ x: number; y: number; w: number; h: number }>,
  gap: number,
): boolean {
  return placed.some(
    (box) => x < box.x + box.w + gap && x + w + gap > box.x && y < box.y + box.h + gap && y + h + gap > box.y,
  );
}

/**
 * Greedy screen-space placement. Higher priority wins the spot.
 * A label that still collides becomes a dot.
 */
export function placeLabels(
  items: readonly PlacementInput[],
  width: number,
  height: number,
  inset: { top: number; right: number; bottom: number; left: number } = { top: 0, right: 0, bottom: 0, left: 0 },
  options: { allowDots?: boolean } = {},
): Placement[] {
  const allowDots = options.allowDots !== false;
  const ordered = items.slice().sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  const result: Placement[] = [];
  const gap = 12;
  const minX = inset.left;
  const minY = inset.top;
  const maxX = Math.max(minX + 20, width - inset.right);
  const maxY = Math.max(minY + 20, height - inset.bottom);
  for (const item of ordered) {
    if (item.anchorX < -40 || item.anchorY < -40 || item.anchorX > width + 40 || item.anchorY > height + 40) continue;
    const dimmed = item.occluded;
    let chosen: Placement | null = null;
    for (const [dx, dy] of OFFSETS) {
      const left = Math.max(minX, Math.min(maxX - item.width, item.anchorX + dx));
      const top = Math.max(minY, Math.min(maxY - item.height, item.anchorY + dy - item.height / 2));
      if (overlaps(left, top, item.width, item.height, placed, gap)) continue;
      chosen = { id: item.id, mode: 'label', x: left, y: top, dimmed };
      placed.push({ x: left, y: top, w: item.width, h: item.height });
      break;
    }
    if (!chosen) {
      if (!allowDots) continue;
      const left = Math.max(minX + 8, Math.min(maxX - 8, item.anchorX));
      const top = Math.max(minY + 8, Math.min(maxY - 8, item.anchorY));
      chosen = { id: item.id, mode: 'dot', x: left, y: top, dimmed };
      placed.push({ x: left - 7, y: top - 7, w: 14, h: 14 });
    }
    result.push(chosen);
  }
  return result;
}

export type ColumnInput = {
  id: string;
  anchorX: number;
  anchorY: number;
  width: number;
  height: number;
  priority?: number;
};

/**
 * Stack labels in a column beside the anchors, inside the free rectangle.
 * Lowest priority is dropped when the column is taller than that rectangle.
 */
export function columnPlacements(
  items: readonly ColumnInput[],
  width: number,
  height: number,
  inset: { top: number; right: number; bottom: number; left: number } = { top: 0, right: 0, bottom: 0, left: 0 },
): Placement[] {
  if (!items.length) return [];
  const gap = 8;
  const minX = inset.left;
  const minY = inset.top;
  const maxX = Math.max(minX + 24, width - inset.right);
  const maxY = Math.max(minY + 20, height - inset.bottom);
  const availH = Math.max(20, maxY - minY);
  const ranked = items
    .slice()
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
  const kept: ColumnInput[] = [];
  let used = 0;
  for (const item of ranked) {
    const next = used + item.height + (kept.length ? gap : 0);
    if (next > availH) continue;
    kept.push(item);
    used = next;
  }
  if (!kept.length) {
    const first = ranked[0];
    if (first) kept.push(first);
  }
  const aLeft = Math.min(...kept.map((item) => item.anchorX));
  const aRight = Math.max(...kept.map((item) => item.anchorX));
  const labelW = Math.min(maxX - minX, Math.max(...kept.map((item) => item.width)));
  const spaceRight = maxX - aRight;
  const spaceLeft = aLeft - minX;
  const placeRight = spaceRight >= spaceLeft;
  let x = placeRight ? maxX - labelW : minX;
  if (placeRight && x < aRight + 10 && spaceLeft >= labelW + 10) x = Math.max(minX, aLeft - 10 - labelW);
  if (!placeRight && x + labelW > aLeft - 10 && spaceRight >= labelW + 10) x = Math.min(maxX - labelW, aRight + 10);
  x = Math.max(minX, Math.min(maxX - labelW, x));
  const totalH = kept.reduce((sum, item) => sum + item.height, 0) + gap * Math.max(0, kept.length - 1);
  const meanY = kept.reduce((sum, item) => sum + item.anchorY, 0) / kept.length;
  let y = Math.max(minY, Math.min(maxY - Math.min(totalH, availH), meanY - totalH / 2));
  return kept
    .slice()
    .sort((a, b) => a.anchorY - b.anchorY || a.id.localeCompare(b.id))
    .map((item) => {
      const placement: Placement = { id: item.id, mode: 'label', x, y, dimmed: false };
      y += item.height + gap;
      return placement;
    });
}

export function estimateLabelSize(text: string, twoLines = false): { width: number; height: number } {
  return { width: Math.min(168, Math.max(48, text.length * 7.4 + 12)), height: twoLines ? 34 : 18 };
}
