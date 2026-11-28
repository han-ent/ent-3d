export type SheetSnap = 'peek' | 'half' | 'full';

const ORDER: SheetSnap[] = ['peek', 'half', 'full'];

export function nextSnap(current: SheetSnap): SheetSnap {
  const index = ORDER.indexOf(current);
  return ORDER[(index + 1) % ORDER.length] ?? 'peek';
}

/**
 * Release cover, in pixels from the bottom, chooses the nearest snap.
 * `velocityY` is pixels per millisecond; negative moves the finger up.
 * A flick skips one snap past that nearest point.
 */
export function snapFromRelease(coverPx: number, velocityY: number, viewportHeight: number): SheetSnap {
  let best: SheetSnap = 'peek';
  let bestGap = Infinity;
  for (const snap of ORDER) {
    const gap = Math.abs(sheetCoverPx(snap, viewportHeight) - coverPx);
    if (gap < bestGap) {
      best = snap;
      bestGap = gap;
    }
  }
  const flick = Math.abs(velocityY) >= 0.65;
  if (!flick) return best;
  const index = ORDER.indexOf(best);
  if (velocityY < 0 && index < ORDER.length - 1) return ORDER[index + 1] ?? best;
  if (velocityY > 0 && index > 0) return ORDER[index - 1] ?? best;
  return best;
}

/** Drag delta from `start`. Negative deltaY opens the sheet. */
export function snapAfterDrag(start: SheetSnap, deltaY: number, viewportHeight: number, velocityY = 0): SheetSnap {
  const cover = sheetCoverPx(start, viewportHeight) - deltaY;
  return snapFromRelease(cover, velocityY, viewportHeight);
}

export function sheetCoverPx(snap: SheetSnap, viewportHeight: number): number {
  if (snap === 'peek') return 130;
  if (snap === 'half') {
    const share = Math.round(viewportHeight * 0.42);
    const floor = viewportHeight <= 700 ? 428 : 220;
    return Math.max(floor, share);
  }
  return Math.round(Math.min(viewportHeight * 0.92, Math.max(280, viewportHeight - 48)));
}

/** True when the CT block in the sheet can be seen. */
export function ctPanelVisible(snap: SheetSnap, desktop: boolean): boolean {
  if (desktop) return true;
  return snap === 'half' || snap === 'full';
}
