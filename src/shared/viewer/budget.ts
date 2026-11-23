/** Pixel ratio cap. Phones stay at 1.5, and drop to 1 while the view is moving. */
export function choosePixelRatio(devicePixelRatio: number, compact: boolean, interacting: boolean): number {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const cap = compact ? (interacting ? 1 : 1.5) : interacting ? 1.25 : 2;
  return Math.min(dpr, cap);
}

/**
 * True when every corner of a box is inside a sphere.
 * A sphere is convex, so the box is inside too.
 */
export function coveredBySphere(
  corners: readonly [number, number, number][],
  center: readonly [number, number, number],
  radius: number,
): boolean {
  if (!(radius > 0) || corners.length === 0) return false;
  const r2 = radius * radius;
  for (const corner of corners) {
    const dx = corner[0] - center[0];
    const dy = corner[1] - center[1];
    const dz = corner[2] - center[2];
    if (dx * dx + dy * dy + dz * dz >= r2) return false;
  }
  return true;
}
