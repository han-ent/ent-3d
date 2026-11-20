import type { Vec3 } from './types';

/** Lateral view of the right ear, framed on the middle and inner ear rather than the whole specimen. */
export const DEFAULT_FOV = 34;

export const DEFAULT_CAMERA = {
  position: [70, 16, 38] as Vec3,
  target: [24, 22, 33] as Vec3,
  up: [0, 0, 1] as Vec3,
  fov: DEFAULT_FOV,
};

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
