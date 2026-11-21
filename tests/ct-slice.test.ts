import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyWindowLevel, indexAlong, pointOnSlice, segmentOnPlane, sliceFractions } from '../src/shared/ct-slice';
import { slicePose } from '../src/shared/ct';
import type { VolumeMeta } from '../src/shared/types';
import { distanceMm } from '../src/shared/measurement';
import { isOutsideAabb, verticalSpanMm } from '../src/shared/view-pose';
import type { PresetFile } from '../src/shared/types';

describe('slice window and crosshair mapping', () => {
  it('leaves a full window close to the stored grayscale', () => {
    expect(applyWindowLevel(0, 255, 128)).toBe(0);
    expect(applyWindowLevel(255, 255, 128)).toBe(255);
    expect(applyWindowLevel(128, 255, 128)).toBeGreaterThan(120);
    expect(applyWindowLevel(128, 255, 128)).toBeLessThan(136);
  });

  it('round-trips a point on the axial slice', () => {
    const volume = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../public/temporal-bone/ct/volume.json'), 'utf8'),
    ) as VolumeMeta;
    const index = volume.planes.axial.initial_index ?? 0;
    const point = pointOnSlice(volume, 'axial', index, 0.25, 0.4);
    const back = sliceFractions(volume, 'axial', index, point);
    expect(back.col01).toBeCloseTo(0.25, 5);
    expect(back.row01).toBeCloseTo(0.4, 5);
    expect(indexAlong(volume, 2, point)).toBe(index);
    const pose = slicePose(volume, 'axial', index);
    expect(point[2]).toBeCloseTo(pose.position[2], 5);
  });

  it('clips a triangle to the slice plane', () => {
    const segment = segmentOnPlane([0, 0, -1], [0, 0, 1], [1, 0, 1], [0, 0, 0], [0, 0, 1]);
    expect(segment).not.toBeNull();
    expect(segment?.[0][2]).toBeCloseTo(0);
    expect(segment?.[1][2]).toBeCloseTo(0);
  });
});

describe('preset cameras', () => {
  it('sits outside the bone and frames about 10–20 mm', () => {
    const root = resolve(import.meta.dirname, '..');
    const presets = JSON.parse(readFileSync(resolve(root, 'public/temporal-bone/presets.json'), 'utf8')) as PresetFile;
    const buf = readFileSync(resolve(root, 'public/temporal-bone/models/bone.glb'));
    const doc = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8')) as {
      accessors: { min?: number[]; max?: number[]; type: string }[];
    };
    const position = doc.accessors.find((accessor) => accessor.type === 'VEC3' && accessor.min && accessor.max)!;
    const min = position.min as [number, number, number];
    const max = position.max as [number, number, number];
    for (const sequence of presets.sequences) {
      for (const step of sequence.steps) {
        const span = verticalSpanMm(distanceMm(step.camera.position, step.camera.target), step.camera.fov ?? 34);
        expect(span, step.id).toBeGreaterThanOrEqual(40);
        expect(span, step.id).toBeLessThanOrEqual(70);
        expect(isOutsideAabb(step.camera.position, min, max), step.id).toBe(true);
      }
    }
    const transcanal = presets.sequences.find((sequence) => sequence.id === 'transcanal')?.steps[0];
    expect(transcanal?.highlight).toBe('tympanic-membrane');
    expect(transcanal?.hidden).toContain('external-auditory-canal');
    expect(distanceMm(transcanal!.camera.target, [25.28, 25.35, 31.58])).toBeLessThan(1);
  });
});
