import { clampDragStep, MAX_HOLD_STEP_RAD, resumeDragPixels } from '../shared/orbit-guard';

/** One frame of camera drag, capped at the shared 6° hold step. */
export function dragAngle(pixels: number): number {
  return clampDragStep(pixels * 0.01, MAX_HOLD_STEP_RAD);
}

export type PointerPoint = { x: number; y: number };

/**
 * After a second finger lifts, the next one-finger move must not include the
 * distance travelled while pinching. The shared helper reports that distance
 * as 0 when the baseline is reset.
 */
export function baselineAfterPinch(tracked: PointerPoint, current: PointerPoint): { point: PointerPoint; jump: number } {
  return { point: { x: current.x, y: current.y }, jump: resumeDragPixels(tracked, current, true) };
}

export type OrbitView = {
  azimuth: number;
  polar: number;
  radius: number;
  target: [number, number, number];
};

/** Face-on, slightly above and to the patient's right. */
export const ORBIT_VIEWS: Record<'head' | 'labyrinth' | 'brainstem' | 'eyes', OrbitView> = {
  head: { azimuth: 0.28, polar: 1.18, radius: 290, target: [0, 10, -8] },
  labyrinth: { azimuth: 0.85, polar: 1.28, radius: 78, target: [68, 0, 12] },
  brainstem: { azimuth: 0.2, polar: 1.22, radius: 145, target: [0, 6, 8] },
  eyes: { azimuth: 0.08, polar: 1.22, radius: 125, target: [0, 14, -76] },
};

export function clampPolar(polar: number): number {
  return Math.min(2.55, Math.max(0.28, polar));
}

export function clampRadius(radius: number): number {
  return Math.min(680, Math.max(42, radius));
}

/** Pinch zoom, limited so one frame cannot jump the camera in or out. */
export function zoomRadius(radius: number, scale: number): number {
  const requested = radius * (Number.isFinite(scale) && scale > 0 ? scale : 1);
  const capped = Math.min(radius * 1.12, Math.max(radius * 0.88, requested));
  return clampRadius(capped);
}
