import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { pointInsideMesh } from '../src/shared/surface-anchor';
import type { Vec3 } from '../src/shared/types';
import {
  COCHLEA_PARTS,
  STAGE_LIMITS,
  fitDistanceMm,
  groupPickId,
  labelAction,
  orbitAbout,
  stopDistanceMm,
  viewOffsetFor,
  viewTangent,
  visibleFovDeg,
  zoomAboutAnchor,
  zoomStructureSize,
} from '../src/shared/zoom-fit';

function cubeTriangles(min: number, max: number): number[] {
  const c = (x: number, y: number, z: number): Vec3 => [x, y, z];
  const corners = [
    c(min, min, min),
    c(max, min, min),
    c(max, max, min),
    c(min, max, min),
    c(min, min, max),
    c(max, min, max),
    c(max, max, max),
    c(min, max, max),
  ];
  const faces = [
    [0, 1, 2, 0, 2, 3],
    [4, 6, 5, 4, 7, 6],
    [0, 4, 5, 0, 5, 1],
    [3, 2, 6, 3, 6, 7],
    [0, 3, 7, 0, 7, 4],
    [1, 5, 6, 1, 6, 2],
  ];
  const flat: number[] = [];
  for (const face of faces) {
    for (const index of face) flat.push(...corners[index]!);
  }
  return flat;
}

describe('stage distance limits', () => {
  it('uses a closer range for the smaller stages', () => {
    expect(STAGE_LIMITS.body).toEqual({ min: 300, max: 1500 });
    expect(STAGE_LIMITS.ear).toEqual({ min: 40, max: 500 });
    expect(STAGE_LIMITS.bone).toEqual({ min: 15, max: 400 });
    expect(STAGE_LIMITS.inner).toEqual({ min: 4, max: 150 });
    expect(STAGE_LIMITS.inner.min).toBeLessThan(STAGE_LIMITS.bone.min);
    expect(STAGE_LIMITS.bone.min).toBeLessThan(STAGE_LIMITS.ear.min);
    expect(STAGE_LIMITS.ear.min).toBeLessThan(STAGE_LIMITS.body.min);
  });

  it('stops at 0.6 × the structure size or the stage minimum, whichever is farther', () => {
    expect(stopDistanceMm(10, 4)).toBeCloseTo(6);
    expect(stopDistanceMm(2, 15)).toBe(15);
    expect(stopDistanceMm(80, 15)).toBeCloseTo(48);
    expect(zoomStructureSize('skin', 400)).toBe(0);
    expect(zoomStructureSize('bone', 60)).toBe(60);
  });

  it('clamps a zoom-in and a zoom-out to the stage range', () => {
    const limits = STAGE_LIMITS.body;
    const camera: Vec3 = [0, 0, 800];
    const target: Vec3 = [0, 0, 0];
    const anchor: Vec3 = [0, 0, 40];
    const inn = zoomAboutAnchor({
      camera,
      target,
      anchor,
      scale: 0.05,
      minDistance: limits.min,
      maxDistance: limits.max,
      stopDistance: stopDistanceMm(0, limits.min),
    });
    expect(inn.distance).toBeGreaterThanOrEqual(limits.min - 1e-6);
    expect(len(sub(inn.camera, anchor))).toBeGreaterThanOrEqual(limits.min - 1e-6);
    const out = zoomAboutAnchor({
      camera,
      target,
      anchor,
      scale: 4,
      minDistance: limits.min,
      maxDistance: limits.max,
      stopDistance: limits.min,
    });
    expect(out.distance).toBeLessThanOrEqual(limits.max + 1e-6);
  });
});

describe('zoom anchor', () => {
  it('keeps the anchor fixed under the finger', () => {
    const camera: Vec3 = [12, -6, 90];
    const target: Vec3 = [2, 4, 10];
    const anchor: Vec3 = [8, -1, 18];
    const before = viewTangent(camera, target, anchor);
    const next = zoomAboutAnchor({
      camera,
      target,
      anchor,
      scale: 0.42,
      minDistance: 4,
      maxDistance: 400,
      stopDistance: 6,
    });
    const after = viewTangent(next.camera, next.target, anchor);
    expect(after[0]).toBeCloseTo(before[0], 5);
    expect(after[1]).toBeCloseTo(before[1], 5);
    expect(after[2]).toBeCloseTo(before[2], 5);
    expect(len(sub(next.camera, anchor))).toBeGreaterThanOrEqual(6 - 1e-6);
  });

  it('keeps the current target when the ray misses', () => {
    const camera: Vec3 = [0, 0, 100];
    const target: Vec3 = [4, 5, 6];
    const next = zoomAboutAnchor({
      camera,
      target,
      anchor: null,
      scale: 0.5,
      minDistance: 10,
      maxDistance: 500,
      stopDistance: 10,
    });
    expect(next.target).toEqual(target);
    const start = Math.hypot(camera[0] - target[0], camera[1] - target[1], camera[2] - target[2]);
    expect(next.distance).toBeCloseTo(start * 0.5, 4);
  });

  it('does not move the camera into the mesh', () => {
    const triangles = cubeTriangles(-8, 8);
    const anchor: Vec3 = [0, 0, 8];
    const camera: Vec3 = [0, 0, 80];
    const target: Vec3 = [0, 0, 0];
    expect(pointInsideMesh(camera, triangles, null)).toBe(false);
    const radius = Math.hypot(8, 8, 8);
    const next = zoomAboutAnchor({
      camera,
      target,
      anchor,
      scale: 0.01,
      minDistance: 4,
      maxDistance: 400,
      stopDistance: stopDistanceMm(radius, 4),
    });
    expect(pointInsideMesh(next.camera, triangles, null)).toBe(false);
    expect(len(sub(next.camera, anchor))).toBeGreaterThan(radius * 0.6 - 1e-6);
    expect(next.camera[2]).toBeGreaterThan(8);
  });

  it('orbits a tapped point without changing the view direction', () => {
    const camera: Vec3 = [0, 0, 50];
    const target: Vec3 = [0, 0, 0];
    const anchor: Vec3 = [6, -3, 4];
    const next = orbitAbout(camera, target, anchor);
    expect(next.target).toEqual(anchor);
    expect(sub(next.camera, next.target)).toEqual(sub(camera, target));
  });
});

describe('visible-area fit', () => {
  it('puts the look-at point in the centre of the unobscured rectangle', () => {
    const width = 390;
    const height = 700;
    const visible = { x: 0, y: 64, width: 310, height: 400 };
    const camera = new THREE.PerspectiveCamera(32, width / height, 0.1, 5000);
    camera.position.set(0, 0, 200);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const offset = viewOffsetFor(width, height, visible);
    camera.setViewOffset(offset.fullWidth, offset.fullHeight, offset.x, offset.y, offset.width, offset.height);
    const projected = new THREE.Vector3(0, 0, 0).project(camera);
    const x = (projected.x * 0.5 + 0.5) * width;
    const y = (-projected.y * 0.5 + 0.5) * height;
    expect(x).toBeCloseTo(visible.x + visible.width / 2, 0);
    expect(y).toBeCloseTo(visible.y + visible.height / 2, 0);
  });

  it('steps back when the sheet covers part of the canvas', () => {
    const full = fitDistanceMm({
      radiusMm: 12,
      fovDeg: 32,
      canvasWidth: 390,
      canvasHeight: 800,
      visibleWidth: 390,
      visibleHeight: 800,
    });
    const covered = fitDistanceMm({
      radiusMm: 12,
      fovDeg: 32,
      canvasWidth: 390,
      canvasHeight: 800,
      visibleWidth: 320,
      visibleHeight: 460,
    });
    expect(covered).toBeGreaterThan(full);
    expect(visibleFovDeg(32, 800, 400)).toBeLessThan(32);
  });
});

describe('representative labels', () => {
  it('links Cochlea, Vestibule, and IAC to real structures', () => {
    expect(labelAction('cochlea')).toEqual({ kind: 'cochlea', structureId: 'scala-vestibuli' });
    expect(labelAction('vestibule').structureId).toBe('vestibule');
    expect(labelAction('vestibule-center').structureId).toBe('vestibule');
    expect(labelAction('iac')).toEqual({ kind: 'iac', structureId: 'cochleovestibular-nerve' });
    expect(COCHLEA_PARTS).toContain('scala-vestibuli');
    expect(COCHLEA_PARTS).toContain('scala-tympani');
    expect(groupPickId('scala-vestibuli-basal')).toBe('cochlea');
    expect(groupPickId('vestibule')).toBe('vestibule');
  });
});

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function len(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
