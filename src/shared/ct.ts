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
 * RAS stacks: axial is constant Z, coronal constant Y, sagittal constant X.
 * Columns follow the first in-plane axis. Rows follow the second, with file row 0 at the high end.
 */
export function planeAxes(plane: 'axial' | 'coronal' | 'sagittal'): {
  normal: 0 | 1 | 2;
  col: 0 | 1 | 2;
  row: 0 | 1 | 2;
} {
  if (plane === 'axial') return { normal: 2, col: 0, row: 1 };
  if (plane === 'coronal') return { normal: 1, col: 0, row: 2 };
  return { normal: 0, col: 1, row: 2 };
}

export function slicePose(volume: VolumeMeta, plane: 'axial' | 'coronal' | 'sagittal', index: number): SlicePose {
  const def = volume.planes[plane];
  const ijk: Vec3 = [
    (volume.dims[0] - 1) / 2,
    (volume.dims[1] - 1) / 2,
    (volume.dims[2] - 1) / 2,
  ];
  ijk[def.axis] = index;
  const u = directionColumn(volume.direction, def.col_axis);
  let v = directionColumn(volume.direction, def.row_axis);
  // flipY false puts file row 0 at texture v=0, the bottom of the plane (local −Y).
  // When that row is the high end of the row axis, local +Y must point toward the low end.
  if (!volume.texture_flip_y && def.row_0_is_max) {
    v = [-v[0], -v[1], -v[2]];
  }
  return {
    position: voxelCenter(volume, ijk[0], ijk[1], ijk[2]),
    normal: directionColumn(volume.direction, def.axis),
    u,
    v,
    width: volume.dims[def.col_axis] * volume.spacing_mm[def.col_axis],
    height: volume.dims[def.row_axis] * volume.spacing_mm[def.row_axis],
  };
}

export function sliceFile(folder: string, index: number, digits = 3, extension = 'webp'): string {
  return `${folder}/${String(index).padStart(digits, '0')}.${extension}`;
}

export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(index)));
}
