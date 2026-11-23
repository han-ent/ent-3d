import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDimension, det3, pairDistances, rms, umeyama, type Mat3 } from '../src/shared/registration';
import type { Vec3 } from '../src/shared/types';

function apply(rotation: Mat3, scale: number, translation: Vec3, point: Vec3): Vec3 {
  return [
    scale * (rotation[0][0] * point[0] + rotation[0][1] * point[1] + rotation[0][2] * point[2]) + translation[0],
    scale * (rotation[1][0] * point[0] + rotation[1][1] * point[1] + rotation[1][2] * point[2]) + translation[1],
    scale * (rotation[2][0] * point[0] + rotation[2][1] * point[1] + rotation[2][2] * point[2]) + translation[2],
  ];
}

describe('Umeyama registration', () => {
  it('recovers a known similarity', () => {
    const source: Vec3[] = [
      [0, 0, 0],
      [10, 0, 0],
      [0, 8, 0],
      [0, 0, 6],
      [3, 4, 2],
      [7, 1, 5],
      [2, 6, 4],
    ];
    const rotation: Mat3 = [
      [0, 0, 1],
      [0, 1, 0],
      [-1, 0, 0],
    ];
    const target = source.map((point) => apply(rotation, 1.25, [4, -2, 9], point));
    const fit = umeyama(source, target);
    expect(fit.rmsMm).toBeLessThan(1e-6);
    expect(fit.scale).toBeCloseTo(1.25, 5);
    expect(det3(fit.rotation)).toBeCloseTo(1, 5);
    const moved = apply(fit.rotation, fit.scale, fit.translation, source[4]);
    expect(moved[0]).toBeCloseTo(target[4][0], 4);
    expect(moved[1]).toBeCloseTo(target[4][1], 4);
    expect(moved[2]).toBeCloseTo(target[4][2], 4);
  });

  it('keeps a proper rotation when the target is mirrored', () => {
    const source: Vec3[] = [
      [0, 0, 0],
      [4, 0, 0],
      [0, 3, 0],
      [0, 0, 2],
      [1, 1, 1],
    ];
    const target = source.map((point) => [point[0], point[1], -point[2]] as Vec3);
    const fit = umeyama(source, target);
    expect(det3(fit.rotation)).toBeCloseTo(1, 5);
    expect(fit.scale).toBeGreaterThan(0);
  });

  it('matches the stored skull-to-ZETA pairs and keeps scale 1', () => {
    const file = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../public/models/upper-body/registration.json'), 'utf8'),
    ) as {
      scale: number;
      appliedScale: number;
      review: string;
      current: { rmsMm: number; pairs: { zetaMm: Vec3; skullMm: Vec3; residualMm: number }[] };
      umeyama: { scale: number; rmsMm: number; residualsMm: number[] };
      dimensions: { id: string; valueMm: number; meanMm: number; sdMm: number; flagged: boolean }[];
    };
    expect(file.review).toBe('미검증');
    expect(file.appliedScale).toBe(1);
    expect(file.scale).toBe(1);
    const skull = file.current.pairs.map((pair) => pair.skullMm);
    const zeta = file.current.pairs.map((pair) => pair.zetaMm);
    const current = pairDistances(skull, zeta);
    current.forEach((value, index) => expect(value).toBeCloseTo(file.current.pairs[index].residualMm, 2));
    expect(rms(current)).toBeCloseTo(file.current.rmsMm, 2);
    const fit = umeyama(skull, zeta);
    expect(fit.scale).toBeCloseTo(file.umeyama.scale, 3);
    expect(fit.rmsMm).toBeCloseTo(file.umeyama.rmsMm, 2);
    fit.residualsMm.forEach((value, index) => expect(value).toBeCloseTo(file.umeyama.residualsMm[index], 2));
    expect(det3(fit.rotation)).toBeCloseTo(1, 4);
    for (const dimension of file.dimensions) {
      expect(checkDimension(dimension.id, dimension.valueMm, dimension.meanMm, dimension.sdMm).flagged).toBe(
        dimension.flagged,
      );
    }
  });
});
