/** Structures that wrap the middle and inner ear. A tap should prefer what is inside them. */
export const ENVELOPE_IDS = new Set(['bone', 'external-auditory-canal', 'sinus-dura']);

/** Finger slop on a phone. Rays inside this radius still count. */
export const TOUCH_TOLERANCE_PX = 12;

export type PickCandidate = {
  structureId: string;
  /** Distance from the camera along the ray, in world units (millimetres). */
  distance: number;
  /** Smaller structures win. Use a bounding diagonal or radius, in millimetres. */
  size: number;
  /** True when the ray is the finger centre, not a tolerance sample. */
  central: boolean;
  envelope?: boolean;
};

export function isEnvelope(id: string): boolean {
  return ENVELOPE_IDS.has(id);
}

export type TouchSample = { x: number; y: number; central: boolean };

/** Centre ray plus eight rays on a circle of `radiusPx`. */
export function touchSampleOffsets(radiusPx = TOUCH_TOLERANCE_PX): TouchSample[] {
  const samples: TouchSample[] = [{ x: 0, y: 0, central: true }];
  for (let i = 0; i < 8; i += 1) {
    const angle = (i / 8) * Math.PI * 2;
    samples.push({ x: Math.cos(angle) * radiusPx, y: Math.sin(angle) * radiusPx, central: false });
  }
  return samples;
}

function bySizeThenDistance<T extends PickCandidate>(items: readonly T[]): T {
  return items.slice().sort((a, b) => a.size - b.size || a.distance - b.distance)[0]!;
}

function byDistance<T extends PickCandidate>(items: readonly T[]): T {
  return items.slice().sort((a, b) => a.distance - b.distance)[0]!;
}

/**
 * Choose the structure a tap should select.
 * A direct hit on an inner structure wins, smallest first.
 * If the finger only lands on an envelope, an inner structure within the tolerance still wins.
 * Envelopes are selected only when no inner structure was hit.
 */
export function choosePick<T extends PickCandidate>(candidates: readonly T[]): T | null {
  if (candidates.length === 0) return null;
  const tagged = candidates.map((candidate) => ({
    ...candidate,
    envelope: candidate.envelope ?? isEnvelope(candidate.structureId),
  }));
  const centralInner = tagged.filter((candidate) => candidate.central && !candidate.envelope);
  if (centralInner.length > 0) return bySizeThenDistance(centralInner);
  const nearInner = tagged.filter((candidate) => !candidate.envelope);
  if (nearInner.length > 0) return bySizeThenDistance(nearInner);
  const centralEnvelope = tagged.filter((candidate) => candidate.central);
  if (centralEnvelope.length > 0) return byDistance(centralEnvelope);
  return byDistance(tagged);
}

export type OpacityInput = {
  id: string;
  base: number;
  selectedId: string | null;
  dimOthers: boolean;
  ghost: boolean;
  boneTransparent: boolean;
};

/** Opacity used while a structure is selected. Unselected structures fall to a light gray wash. */
export function displayOpacity(input: OpacityInput): number {
  if (input.selectedId !== null && input.id === input.selectedId) return 1;
  if (input.dimOthers && input.selectedId !== null) return 0.15;
  let opacity = input.base;
  if (input.id === 'bone' && input.boneTransparent) opacity = Math.min(opacity, 0.12);
  if (input.ghost) opacity = Math.min(opacity, 0.1);
  return opacity;
}
