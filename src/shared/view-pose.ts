import type { Vec3 } from './types';

/**
 * Lateral view of the whole right temporal bone.
 * Distance is far enough that a phone-tall canvas shows about a 20 mm scale bar
 * and the bone silhouette fits the narrow width, with the middle ear near the centre.
 */
export const DEFAULT_FOV = 32;

export const DEFAULT_CAMERA = {
  position: [24, 8, -150] as Vec3,
  target: [23, 30, 30] as Vec3,
  up: [0, -1, 0] as Vec3,
  fov: DEFAULT_FOV,
};

/** Vertical field used when framing one structure, so neighbours stay in view. */
export const SELECTION_SPAN_MM = 58;

/** Vertical field for a dissection step: a surgical field, not a single ossicle. */
export const PRESET_SPAN_MM = 55;

/** Vertical extent, in millimetres, of the view at `distance` from the camera. */
export function verticalSpanMm(distance: number, fovDeg: number): number {
  return 2 * distance * Math.tan((fovDeg * Math.PI) / 360);
}

export function isOutsideAabb(point: Vec3, min: Vec3, max: Vec3): boolean {
  return (
    point[0] <= min[0] ||
    point[0] >= max[0] ||
    point[1] <= min[1] ||
    point[1] >= max[1] ||
    point[2] <= min[2] ||
    point[2] >= max[2]
  );
}
