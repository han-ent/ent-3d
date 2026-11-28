/** Largest view-direction change allowed in one frame while a finger is dragging. */
export const MAX_DRAG_STEP_RAD = 0.45;

/** How far holdOrbit may turn the camera back toward the surface in one frame. */
export const MAX_HOLD_STEP_RAD = (6 * Math.PI) / 180;

function len(v: readonly [number, number, number]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/** Angle between two offsets, in radians. */
export function offsetAngle(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const al = len(a);
  const bl = len(b);
  if (al < 1e-8 || bl < 1e-8) return 0;
  const dot = Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (al * bl)));
  return Math.acos(dot);
}

/**
 * Move `current` toward `desired` by at most `maxRad`.
 * A close-up drag used to be snapped the whole way back onto the last zoom
 * direction (about 70°) the moment it left that cone.
 */
export function easeOrbitOffset(
  current: readonly [number, number, number],
  desired: readonly [number, number, number],
  maxRad: number,
): [number, number, number] {
  const cl = len(current);
  const dl = len(desired);
  if (cl < 1e-8 || dl < 1e-8) return [desired[0], desired[1], desired[2]];
  const turn = offsetAngle(current, desired);
  if (turn <= maxRad || turn >= Math.PI - 1e-3) return [desired[0], desired[1], desired[2]];
  const t = maxRad / turn;
  const ux = current[0] / cl;
  const uy = current[1] / cl;
  const uz = current[2] / cl;
  const vx = desired[0] / dl;
  const vy = desired[1] / dl;
  const vz = desired[2] / dl;
  const x = ux + (vx - ux) * t;
  const y = uy + (vy - uy) * t;
  const z = uz + (vz - uz) * t;
  const n = Math.hypot(x, y, z) || 1;
  return [(x / n) * dl, (y / n) * dl, (z / n) * dl];
}

/**
 * How far a resumed one-finger drag would spin if OrbitControls kept the
 * pointer position from before a second finger froze tracking.
 * Resetting the baseline makes that distance zero.
 */
export function resumeDragPixels(
  tracked: { x: number; y: number },
  current: { x: number; y: number },
  resetBaseline: boolean,
): number {
  if (resetBaseline) return 0;
  return Math.hypot(current.x - tracked.x, current.y - tracked.y);
}

/** Shortest signed angle, then clamped so one frame cannot spin the view. */
export function clampDragStep(angleRad: number, maxRad = MAX_DRAG_STEP_RAD): number {
  if (!Number.isFinite(angleRad)) return 0;
  let wrapped = angleRad;
  const turn = Math.PI * 2;
  while (wrapped > Math.PI) wrapped -= turn;
  while (wrapped < -Math.PI) wrapped += turn;
  return Math.max(-maxRad, Math.min(maxRad, wrapped));
}
