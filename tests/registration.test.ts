import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDimension, det3, rms, umeyama, type Mat3 } from '../src/shared/registration';
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

  it('applies a scale-1 rigid map and keeps the outer-landmark gaps', () => {
    const file = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../public/models/upper-body/registration.json'), 'utf8'),
    ) as {
      scale: number;
      appliedScale: number;
      review: string;
      containment: { outsideFraction: number; outsideVertices: number };
      concha: { axisOffsetMm: number };
      applied: { scale: number; rotation: Mat3; translationMm: Vec3; angleDeg: number; rmsMm: number; maps: string };
      current: { rmsMm: number; pairs: { id: string; zetaMm: Vec3; skullMm: Vec3; residualMm: number }[] };
      canalPlanes: { lateralToFrankfortDeg: number; superiorToSagittalDeg: number; posteriorToSagittalDeg: number };
      dimensions: { id: string; valueMm: number; meanMm: number; sdMm: number; flagged: boolean }[];
    };
    expect(file.review).toBe('미검증');
    expect(file.appliedScale).toBe(1);
    expect(file.scale).toBe(1);
    expect(file.applied.scale).toBe(1);
    expect(det3(file.applied.rotation)).toBeCloseTo(1, 4);
    expect(file.applied.angleDeg).toBeGreaterThan(10);
    expect(file.applied.angleDeg).toBeLessThan(40);
    expect(file.containment.outsideVertices).toBe(0);
    expect(file.containment.outsideFraction).toBe(0);
    expect(file.concha.axisOffsetMm).toBeLessThan(3);
    expect(file.applied.maps).toBe('specimen-to-upright-head');
    expect(file.current.pairs.length).toBeGreaterThanOrEqual(5);
    expect(file.current.pairs.some((pair) => pair.id === 'styloid-base' || pair.id === 'henle-spine')).toBe(false);
    const skullKeys = file.current.pairs.map((pair) => pair.skullMm.join(','));
    expect(new Set(skullKeys).size).toBe(skullKeys.length);
    const gaps = file.current.pairs.map((pair) =>
      Math.hypot(pair.skullMm[0] - pair.zetaMm[0], pair.skullMm[1] - pair.zetaMm[1], pair.skullMm[2] - pair.zetaMm[2]),
    );
    gaps.forEach((value, index) => expect(value).toBeCloseTo(file.current.pairs[index].residualMm, 2));
    expect(rms(gaps)).toBeCloseTo(file.current.rmsMm, 2);
    expect(file.current.rmsMm).toBeLessThan(18);
    expect(file.canalPlanes.lateralToFrankfortDeg).toBeGreaterThanOrEqual(25);
    expect(file.canalPlanes.lateralToFrankfortDeg).toBeLessThanOrEqual(30);
    expect(file.canalPlanes.superiorToSagittalDeg).toBeGreaterThanOrEqual(40);
    expect(file.canalPlanes.superiorToSagittalDeg).toBeLessThanOrEqual(55);
    expect(file.canalPlanes.posteriorToSagittalDeg).toBeGreaterThanOrEqual(40);
    expect(file.canalPlanes.posteriorToSagittalDeg).toBeLessThanOrEqual(55);
    for (const dimension of file.dimensions) {
      expect(checkDimension(dimension.id, dimension.valueMm, dimension.meanMm, dimension.sdMm).flagged).toBe(
        dimension.flagged,
      );
    }
  });
});
