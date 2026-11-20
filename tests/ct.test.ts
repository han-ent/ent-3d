import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planeAxes, slicePose, voxelCenter } from '../src/shared/ct';
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
  planes: {
    axial: { axis: 1, folder: 'ct/axial' },
    coronal: { axis: 2, folder: 'ct/coronal' },
    sagittal: { axis: 0, folder: 'ct/sagittal' },
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

  it('centers an axial slice and sizes it in millimetres', () => {
    expect(planeAxes('axial')).toEqual({ normal: 1, u: 0, v: 2 });
    const pose = slicePose(identity, 'axial', 1);
    expect(pose.position).toEqual([3, 2, 3]);
    expect(pose.normal).toEqual([0, 1, 0]);
    expect(pose.width).toBe(8);
    expect(pose.height).toBe(8);
  });

  it('matches the sample volume axes used by the slice files', () => {
    const volume = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../public/temporal-bone/ct/volume.json'), 'utf8'),
    ) as VolumeMeta;
    expect(volume.planes.axial.axis).toBe(planeAxes('axial').normal);
    expect(volume.planes.coronal.axis).toBe(planeAxes('coronal').normal);
    expect(volume.planes.sagittal.axis).toBe(planeAxes('sagittal').normal);
    const pose = slicePose(volume, 'coronal', 0);
    expect(pose.width).toBe(volume.dims[0] * volume.spacing_mm[0]);
    expect(pose.height).toBe(volume.dims[1] * volume.spacing_mm[1]);
  });
});
