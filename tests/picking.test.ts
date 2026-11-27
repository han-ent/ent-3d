import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { choosePick, chooseTap, displayOpacity, overlapChoices, rankTapChoices, shouldStageJump, TOUCH_TOLERANCE_PX, touchSampleOffsets } from '../src/shared/picking';
import { groupPickId } from '../src/shared/zoom-fit';
import type { Manifest } from '../src/shared/types';
import { DEFAULT_CAMERA } from '../src/shared/view-pose';

describe('pick ranking', () => {
  it('uses a 12 px tolerance and keeps the centre ray', () => {
    expect(TOUCH_TOLERANCE_PX).toBe(12);
    const samples = touchSampleOffsets();
    expect(samples[0]).toEqual({ x: 0, y: 0, central: true });
    expect(samples).toHaveLength(9);
    expect(
      samples.filter((sample) => !sample.central).every((sample) => Math.abs(Math.hypot(sample.x, sample.y) - TOUCH_TOLERANCE_PX) < 1e-9),
    ).toBe(true);
  });

  it('lets an inner structure win over a closer envelope', () => {
    const chosen = choosePick([
      { structureId: 'bone', distance: 4, size: 80, central: true },
      { structureId: 'stapes', distance: 12, size: 4, central: true },
    ]);
    expect(chosen?.structureId).toBe('stapes');
  });

  it('keeps a direct hit on a larger inner structure ahead of a nearby smaller one', () => {
    const chosen = choosePick([
      { structureId: 'malleus', distance: 8, size: 9, central: true },
      { structureId: 'stapes', distance: 9, size: 3, central: false },
    ]);
    expect(chosen?.structureId).toBe('malleus');
  });

  it('reaches an inner structure inside the tolerance when the centre only hits bone', () => {
    const chosen = choosePick([
      { structureId: 'bone', distance: 5, size: 80, central: true },
      { structureId: 'facial-nerve', distance: 14, size: 18, central: false },
      { structureId: 'external-auditory-canal', distance: 6, size: 20, central: false },
    ]);
    expect(chosen?.structureId).toBe('facial-nerve');
  });

  it('selects nothing when the rays miss', () => {
    expect(choosePick([])).toBeNull();
  });

  it('does not let the ear hotspot steal a tap that also hits the cochlea', () => {
    const chosen = chooseTap([
      { structureId: 'ear-hotspot', distance: 4, size: 28, central: true, envelope: true },
      { structureId: 'scala-vestibuli', distance: 30, size: 16, central: true },
    ]);
    expect(chosen?.structureId).toBe('scala-vestibuli');
    expect(shouldStageJump('ear-hotspot', ['scala-vestibuli'], 'inner')).toBe(false);
    expect(shouldStageJump('ear-hotspot', [], 'inner')).toBe(false);
    expect(shouldStageJump('skin', [], 'body')).toBe(true);
    expect(shouldStageJump('ear-hotspot', ['scala-vestibuli'], 'ear')).toBe(false);
  });

  it('keeps the front cochlear surface ahead of the vestibule behind it', () => {
    const chosen = chooseTap([
      { structureId: 'scala-vestibuli', distance: 12, size: 16, central: true },
      { structureId: 'vestibule', distance: 20, size: 6, central: true },
    ]);
    expect(chosen?.structureId).toBe('scala-vestibuli');
    const band = overlapChoices([
      { structureId: 'scala-vestibuli', distance: 12, size: 16, central: true },
      { structureId: 'vestibule', distance: 14, size: 6, central: true },
    ]);
    expect(band.map((item) => item.structureId)).toEqual(['scala-vestibuli', 'vestibule']);
    const cochleaFirst = overlapChoices([
      { structureId: 'facial-nerve', distance: 10, size: 20, central: true },
      { structureId: 'scala-vestibuli', distance: 13, size: 16, central: true },
    ]);
    expect(cochleaFirst.map((item) => item.structureId)[0]).toBe('facial-nerve');
    const nerveFirst = overlapChoices([
      { structureId: 'facial-nerve', distance: 10, size: 20, central: true },
      { structureId: 'scala-vestibuli', distance: 30, size: 16, central: true },
    ]);
    expect(nerveFirst[0]?.structureId).toBe('facial-nerve');
  });

  it('ranks a vestibule tap and a cochlea tap from the screen neighbourhood', () => {
    // Vestibule anchor under the finger. The cochlea is still inside the tap radius.
    const vestibuleTap = rankTapChoices([
      { structureId: 'vestibule', distance: 11, size: 8, central: true, screenPx: 4 },
      { structureId: 'cochleovestibular-nerve', distance: 13, size: 18, central: true, screenPx: 20 },
      { structureId: 'scala-vestibuli', distance: 30, size: 16, central: true, screenPx: 18 },
    ]);
    expect(vestibuleTap.map((item) => item.structureId)[0]).toBe('vestibule');
    expect(vestibuleTap.map((item) => groupPickId(item.structureId))).toContain('cochlea');

    // Finger on the cochlea anchor, as at (217, 396) and (223, 402). The first mesh is not the cochlea.
    const cochleaTap = rankTapChoices([
      { structureId: 'facial-nerve', distance: 10, size: 20, central: true, screenPx: 22 },
      { structureId: 'vestibule', distance: 12, size: 8, central: true, screenPx: 16 },
      { structureId: 'scala-vestibuli', distance: 26, size: 16, central: true, screenPx: 6 },
    ]);
    expect(groupPickId(cochleaTap[0]!.structureId)).toBe('cochlea');
    expect(cochleaTap.map((item) => groupPickId(item.structureId))).toContain('cochlea');
    expect(cochleaTap.map((item) => item.structureId)).toContain('vestibule');
  });

  it('dims bone further than the other structures', () => {
    expect(displayOpacity({ id: 'stapes', base: 1, selectedId: 'malleus', dimOthers: true, ghost: false, boneTransparent: false })).toBe(0.15);
    expect(displayOpacity({ id: 'bone', base: 1, selectedId: 'malleus', dimOthers: true, ghost: false, boneTransparent: false })).toBe(0.15);
    expect(displayOpacity({ id: 'malleus', base: 0.4, selectedId: 'malleus', dimOthers: true, ghost: true, boneTransparent: false })).toBe(1);
    expect(displayOpacity({ id: 'bone', base: 1, selectedId: null, dimOthers: false, ghost: false, boneTransparent: true })).toBe(0.12);
  });
});

type Aabb = { id: string; min: THREE.Vector3; max: THREE.Vector3; size: number };

function bounds(file: string): { min: number[]; max: number[] } {
  const buf = readFileSync(file);
  const jsonLength = buf.readUInt32LE(12);
  const doc = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8')) as {
    accessors: { min?: number[]; max?: number[]; type: string }[];
  };
  const position = doc.accessors.find((accessor) => accessor.type === 'VEC3' && accessor.min && accessor.max);
  return { min: position!.min!, max: position!.max! };
}

describe('grid taps on the default lateral view', () => {
  it('selects inner structures through the bone envelope', () => {
    const root = resolve(import.meta.dirname, '..');
    const manifest = JSON.parse(readFileSync(resolve(root, 'public/temporal-bone/manifest.json'), 'utf8')) as Manifest;
    const offset = manifest.viewer_offset_mm;
    const boxes: Aabb[] = manifest.structures.map((structure) => {
      const box = bounds(resolve(root, 'public/temporal-bone', structure.file));
      const min = new THREE.Vector3(box.min[0]! + offset[0], box.min[1]! + offset[1], box.min[2]! + offset[2]);
      const max = new THREE.Vector3(box.max[0]! + offset[0], box.max[1]! + offset[1], box.max[2]! + offset[2]);
      return { id: structure.id, min, max, size: max.clone().sub(min).length() };
    });
    const camera = new THREE.PerspectiveCamera(DEFAULT_CAMERA.fov, 390 / 844, 0.05, 4000);
    camera.up.set(DEFAULT_CAMERA.up[0], DEFAULT_CAMERA.up[1], DEFAULT_CAMERA.up[2]);
    camera.position.set(
      DEFAULT_CAMERA.position[0] + offset[0],
      DEFAULT_CAMERA.position[1] + offset[1],
      DEFAULT_CAMERA.position[2] + offset[2],
    );
    camera.lookAt(
      DEFAULT_CAMERA.target[0] + offset[0],
      DEFAULT_CAMERA.target[1] + offset[1],
      DEFAULT_CAMERA.target[2] + offset[2],
    );
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const raycaster = new THREE.Raycaster();
    const width = 390;
    const height = 844;
    const project = (point: THREE.Vector3) => {
      const ndc = point.clone().project(camera);
      return { x: (ndc.x * 0.5 + 0.5) * width, y: (-ndc.y * 0.5 + 0.5) * height };
    };
    const pickAt = (px: number, py: number) => {
      const gathered = [];
      for (const sample of touchSampleOffsets()) {
        const ndc = new THREE.Vector2(((px + sample.x) / width) * 2 - 1, -(((py + sample.y) / height) * 2 - 1));
        raycaster.setFromCamera(ndc, camera);
        for (const box of boxes) {
          const hit = new THREE.Vector3();
          if (!raycaster.ray.intersectBox(new THREE.Box3(box.min, box.max), hit)) continue;
          gathered.push({
            structureId: box.id,
            distance: hit.distanceTo(raycaster.ray.origin),
            size: box.size,
            central: sample.central,
          });
        }
      }
      return choosePick(gathered)?.structureId ?? null;
    };
    for (const id of ['malleus', 'incus', 'stapes', 'facial-nerve', 'chorda-tympani', 'carotid-artery']) {
      const box = boxes.find((item) => item.id === id)!;
      const screen = project(box.min.clone().add(box.max).multiplyScalar(0.5));
      const chosen = pickAt(screen.x, screen.y);
      expect(chosen, id).not.toBe('bone');
      expect(chosen, id).not.toBe('external-auditory-canal');
      expect(chosen, id).not.toBe('sinus-dura');
      expect(chosen, id).not.toBeNull();
    }
    const tally = new Map<string, number>();
    for (let row = 0; row < 11; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const chosen = pickAt(((col + 0.5) / 8) * width, ((row + 0.5) / 11) * height);
        if (!chosen) continue;
        tally.set(chosen, (tally.get(chosen) ?? 0) + 1);
      }
    }
    const innerHits = ['malleus', 'incus', 'stapes', 'facial-nerve', 'chorda-tympani', 'carotid-artery', 'scala-tympani', 'scala-vestibuli'].reduce(
      (sum, id) => sum + (tally.get(id) ?? 0),
      0,
    );
    expect(innerHits).toBeGreaterThan(0);
  });
});
