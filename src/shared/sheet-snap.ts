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
  const step = Math.max(56, viewportHeight * 0.14);
  let hops = Math.trunc(-deltaY / step);
  if (hops === 0 && Math.abs(deltaY) >= step * 0.35) hops = deltaY < 0 ? 1 : -1;
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
