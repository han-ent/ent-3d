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

/** Which label tiers belong at this camera distance. */
export function tiersForDistance(distanceMm: number): LabelTier[] {
  if (distanceMm > 60) return ['region', 'surface'];
  if (distanceMm > 20) return ['structure'];
  return ['structure', 'subpart'];
}

export type StudyLabel = {
  id: string;
  text: string;
  tier: LabelTier;
  modes: LabelMode[];
  priority: number;
  parentId?: string;
  /** Specimen millimetres. */
  position: [number, number, number];
};

export function labelAllowed(label: StudyLabel, mode: LabelMode, distanceMm: number, selectedParent: string | null): boolean {
  if (mode !== 'all' && !label.modes.includes(mode)) return false;
  if (mode === 'all' && !label.modes.includes('all') && !label.modes.includes('basic') && !label.modes.includes('surgical')) {
    return false;
  }
  const tiers = tiersForDistance(distanceMm);
  if (!tiers.includes(label.tier)) return false;
  if (label.tier === 'subpart') {
    if (!selectedParent) return false;
    return label.parentId === selectedParent || label.id === selectedParent;
  }
  if (distanceMm > 220 && label.tier === 'region') return false;
  return true;
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
): Placement[] {
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
      const left = Math.max(minX + 8, Math.min(maxX - 8, item.anchorX));
      const top = Math.max(minY + 8, Math.min(maxY - 8, item.anchorY));
      chosen = { id: item.id, mode: 'dot', x: left, y: top, dimmed };
      placed.push({ x: left - 7, y: top - 7, w: 14, h: 14 });
    }
    result.push(chosen);
  }
  return result;
}

export function estimateLabelSize(text: string): { width: number; height: number } {
  return { width: Math.min(148, Math.max(48, text.length * 10 + 14)), height: 22 };
}
