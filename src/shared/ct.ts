import type { Vec3, VolumeMeta } from './types';

export type SlicePose = {
  position: Vec3;
  normal: Vec3;
  u: Vec3;
  v: Vec3;
  width: number;
  height: number;
};

/** Column `axis` of a row-major 3×3 direction matrix. */
export function directionColumn(direction: VolumeMeta['direction'], axis: 0 | 1 | 2): Vec3 {
  return [direction[axis], direction[3 + axis], direction[6 + axis]];
}

/** Center of voxel (i, j, k). `origin_mm` is the center of voxel (0, 0, 0). */
export function voxelCenter(volume: VolumeMeta, i: number, j: number, k: number): Vec3 {
  const ijk = [i, j, k];
  const point: Vec3 = [volume.origin_mm[0], volume.origin_mm[1], volume.origin_mm[2]];
  for (let axis = 0; axis < 3; axis += 1) {
    const direction = directionColumn(volume.direction, axis as 0 | 1 | 2);
    const delta = ijk[axis]! * volume.spacing_mm[axis]!;
    point[0] += direction[0] * delta;
    point[1] += direction[1] * delta;
    point[2] += direction[2] * delta;
  }
  return point;
}

/**
 * In-plane axes chosen so the image "up" direction matches the specimen:
 * axial — anterior up; coronal and sagittal — superior up.
 */
export function planeAxes(plane: 'axial' | 'coronal' | 'sagittal'): {
  normal: 0 | 1 | 2;
  u: 0 | 1 | 2;
  v: 0 | 1 | 2;
} {
  if (plane === 'axial') return { normal: 1, u: 0, v: 2 };
  if (plane === 'coronal') return { normal: 2, u: 0, v: 1 };
  return { normal: 0, u: 2, v: 1 };
}

export function slicePose(volume: VolumeMeta, plane: 'axial' | 'coronal' | 'sagittal', index: number): SlicePose {
  const axes = planeAxes(plane);
  const ijk: Vec3 = [
    (volume.dims[0] - 1) / 2,
    (volume.dims[1] - 1) / 2,
    (volume.dims[2] - 1) / 2,
  ];
  ijk[axes.normal] = index;
  return {
    position: voxelCenter(volume, ijk[0], ijk[1], ijk[2]),
    normal: directionColumn(volume.direction, axes.normal),
    u: directionColumn(volume.direction, axes.u),
    v: directionColumn(volume.direction, axes.v),
    width: volume.dims[axes.u] * volume.spacing_mm[axes.u],
    height: volume.dims[axes.v] * volume.spacing_mm[axes.v],
  };
}

export function sliceFile(folder: string, index: number): string {
  return `${folder}/${String(index).padStart(2, '0')}.png`;
}

export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(index)));
}
