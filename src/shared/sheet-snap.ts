export type SheetSnap = 'peek' | 'half' | 'full';

const ORDER: SheetSnap[] = ['peek', 'half', 'full'];

export function nextSnap(current: SheetSnap): SheetSnap {
  const index = ORDER.indexOf(current);
  return ORDER[(index + 1) % ORDER.length] ?? 'peek';
}

/**
 * Dragging up (negative deltaY) opens the sheet. A short drag still moves one snap.
 */
export function snapAfterDrag(start: SheetSnap, deltaY: number, viewportHeight: number): SheetSnap {
  const step = Math.max(48, viewportHeight * 0.12);
  const hopsRaw = -deltaY / step;
  let hops = 0;
  if (Math.abs(hopsRaw) >= 0.35) hops = hopsRaw > 0 ? 1 : -1;
  // A normal drag moves one snap. Only a long fling skips the step in between.
  if (Math.abs(hopsRaw) >= 1.8) hops = hopsRaw > 0 ? 2 : -2;
  const index = Math.max(0, Math.min(ORDER.length - 1, ORDER.indexOf(start) + hops));
  return ORDER[index] ?? start;
}

export function sheetCoverPx(snap: SheetSnap, viewportHeight: number): number {
  if (snap === 'peek') return 130;
  if (snap === 'half') return Math.round(Math.max(220, viewportHeight * 0.42));
  return Math.round(Math.min(viewportHeight * 0.92, Math.max(280, viewportHeight - 48)));
}

/** True when the CT block in the sheet can be seen. */
export function ctPanelVisible(snap: SheetSnap, desktop: boolean): boolean {
  if (desktop) return true;
  return snap === 'half' || snap === 'full';
}
