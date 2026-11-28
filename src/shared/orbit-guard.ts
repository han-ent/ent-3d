/** Largest view-direction change allowed in one frame while a finger is dragging. */
export const MAX_DRAG_STEP_RAD = 0.45;

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
