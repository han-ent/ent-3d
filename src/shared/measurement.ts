import type { Vec3 } from './types';

export type MmPoint = { x: number; y: number; z: number };

export function toPoint(value: Vec3 | MmPoint): MmPoint {
  if (Array.isArray(value)) return { x: value[0], y: value[1], z: value[2] };
  return value;
}

/**
 * Euclidean distance in millimetres.
 * Specimen coordinates are already millimetres, so this value is not scaled.
 * A pure translation (viewer offset) does not change the result.
 */
export function distanceMm(a: Vec3 | MmPoint, b: Vec3 | MmPoint): number {
  const pa = toPoint(a);
  const pb = toPoint(b);
  return Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
}

export function translate(point: MmPoint, offset: Vec3): MmPoint {
  return { x: point.x + offset[0], y: point.y + offset[1], z: point.z + offset[2] };
}

export function formatMm(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const digits = Math.abs(value) >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} mm`;
}

/** Pick a scale-bar length in real millimetres that stays near `targetPx` on screen. */
export function chooseScaleMm(pxPerMm: number, targetPx = 96): { mm: number; px: number } {
  const steps = [1, 2, 5, 10, 20, 50, 100];
  if (!(pxPerMm > 0) || !Number.isFinite(pxPerMm)) return { mm: 10, px: 0 };
  let mm = steps[0]!;
  for (const step of steps) {
    if (step * pxPerMm <= targetPx * 1.35) mm = step;
  }
  return { mm, px: mm * pxPerMm };
}

/**
 * Clipping presets are stored in specimen millimetres.
 * Three.js clips in world space, where the viewer offset is a translation.
 * A point is kept when dot(normal, p) + constant >= 0.
 */
export function worldClippingPlane(
  normal: Vec3,
  constant: number,
  offset: Vec3,
): { normal: Vec3; constant: number } {
  const dot = normal[0] * offset[0] + normal[1] * offset[1] + normal[2] * offset[2];
  return { normal: [normal[0], normal[1], normal[2]], constant: constant - dot };
}
