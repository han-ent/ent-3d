import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { directionColumn, planeAxes, slicePose, voxelCenter } from '../src/shared/ct';
import type { VolumeMeta } from '../src/shared/types';

const identity: VolumeMeta = {
  id: 'test',
  label: { ko: '테스트', en: 'test' },
  model_version: 'test',
  spacing_mm: [2, 2, 2],
  origin_mm: [0, 0, 0],
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  dims: [4, 4, 4],
  voxel_origin: 'center',
  texture_flip_y: false,
  index_digits: 3,
  file_extension: 'webp',
  planes: {
    axial: { axis: 2, folder: 'ct/axial', col_axis: 0, row_axis: 1, row_0_is_max: true },
    coronal: { axis: 1, folder: 'ct/coronal', col_axis: 0, row_axis: 2, row_0_is_max: true },
    sagittal: { axis: 0, folder: 'ct/sagittal', col_axis: 1, row_axis: 2, row_0_is_max: true },
  },
};

describe('CT millimetre placement', () => {
  it('places voxel centers from origin, spacing, and direction columns', () => {
    expect(voxelCenter(identity, 1, 0, 0)).toEqual([2, 0, 0]);
    const swapped: VolumeMeta = {
      ...identity,
      direction: [0, 1, 0, 1, 0, 0, 0, 0, 1],
    };
    expect(voxelCenter(swapped, 1, 0, 0)).toEqual([0, 2, 0]);
  });

  it('centers an axial slice and points local +Y at the low row when flipY is false', () => {
    expect(planeAxes('axial')).toEqual({ normal: 2, col: 0, row: 1 });
    const pose = slicePose(identity, 'axial', 1);
    expect(pose.position).toEqual([3, 3, 2]);
    expect(pose.normal).toEqual([0, 0, 1]);
    expect(pose.u).toEqual([1, 0, 0]);
    expect(pose.v[0]).toBeCloseTo(0);
    expect(pose.v[1]).toBeCloseTo(-1);
    expect(pose.v[2]).toBeCloseTo(0);
    expect(pose.width).toBe(8);
    expect(pose.height).toBe(8);
  });

  it('matches the ZETA volume axes and the published slice size', () => {
    const volume = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../public/temporal-bone/ct/volume.json'), 'utf8'),
    ) as VolumeMeta;
    expect(volume.texture_flip_y).toBe(false);
    expect(volume.planes.axial.axis).toBe(planeAxes('axial').normal);
    expect(volume.planes.coronal.axis).toBe(planeAxes('coronal').normal);
    expect(volume.planes.sagittal.axis).toBe(planeAxes('sagittal').normal);
    const index = volume.planes.axial.initial_index ?? 0;
    const pose = slicePose(volume, 'axial', index);
    expect(pose.width).toBeCloseTo(volume.dims[0] * volume.spacing_mm[0]);
    expect(pose.height).toBeCloseTo(volume.dims[1] * volume.spacing_mm[1]);
    const center = voxelCenter(volume, (volume.dims[0] - 1) / 2, (volume.dims[1] - 1) / 2, index);
    expect(pose.position[0]).toBeCloseTo(center[0], 5);
    expect(pose.position[1]).toBeCloseTo(center[1], 5);
    expect(pose.position[2]).toBeCloseTo(center[2], 5);
    const normal = directionColumn(volume.direction, volume.planes.axial.axis);
    expect(pose.normal[0]).toBeCloseTo(normal[0], 5);
    expect(pose.normal[1]).toBeCloseTo(normal[1], 5);
    expect(pose.normal[2]).toBeCloseTo(normal[2], 5);
    const row = directionColumn(volume.direction, volume.planes.axial.row_axis);
    expect(pose.v[0]).toBeCloseTo(-row[0], 5);
    expect(pose.v[1]).toBeCloseTo(-row[1], 5);
    expect(pose.v[2]).toBeCloseTo(-row[2], 5);
  });
});
