import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { choosePixelRatio, coveredBySphere } from '../src/shared/viewer/budget';

const root = resolve(import.meta.dirname, '..');

type GltfJson = {
  meshes?: { primitives: { indices?: number; attributes: { POSITION?: number } }[] }[];
  accessors: { count: number }[];
};

function gltfJson(file: string): GltfJson {
  const buf = readFileSync(file);
  const jsonLength = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8')) as GltfJson;
}

function triangles(file: string): number {
  const json = gltfJson(file);
  let count = 0;
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      if (prim.indices === undefined) {
        const position = prim.attributes.POSITION;
        count += position === undefined ? 0 : Math.floor(json.accessors[position].count / 3);
      } else {
        count += Math.floor(json.accessors[prim.indices].count / 3);
      }
    }
  }
  return count;
}

function primitives(file: string): number {
  const json = gltfJson(file);
  return (json.meshes ?? []).reduce((sum, mesh) => sum + mesh.primitives.length, 0);
}

/** Small structures stay at their authored density. */
const LOCKED: Record<string, number> = {
  'malleus.glb': 3996,
  'incus.glb': 3996,
  'stapes.glb': 2000,
  'fn-geniculate.glb': 1004,
  'fn-labyrinthine.glb': 1714,
  'fn-mastoid.glb': 10580,
  'fn-second-genu.glb': 1122,
  'fn-tympanic.glb': 5574,
  'chorda-tympani.glb': 5996,
  'cochleovestibular-nerve.glb': 16018,
  'scc-lateral.glb': 2978,
  'scc-posterior.glb': 3922,
  'scc-superior.glb': 3096,
};

describe('viewer performance budget', () => {
  const models = resolve(root, 'public/temporal-bone/models');
  const upper = resolve(root, 'public/models/upper-body');

  it('caps pixel ratio on phones and while the camera is moving', () => {
    expect(choosePixelRatio(3, true, false)).toBe(1.5);
    expect(choosePixelRatio(3, true, true)).toBe(1);
    expect(choosePixelRatio(2, true, false)).toBe(1.5);
    expect(choosePixelRatio(3, false, false)).toBe(2);
    expect(choosePixelRatio(3, false, true)).toBe(1.25);
    expect(choosePixelRatio(1, false, false)).toBe(1);
    expect(choosePixelRatio(1, true, true)).toBe(1);
  });

  it('treats a box as inside a sphere only when every corner is inside', () => {
    const box: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [0, 0, 1],
      [1, 0, 1],
      [0, 1, 1],
      [1, 1, 1],
    ];
    expect(coveredBySphere(box, [0.5, 0.5, 0.5], 1)).toBe(true);
    expect(coveredBySphere(box, [0.5, 0.5, 0.5], 0.8)).toBe(false);
    expect(coveredBySphere(box, [0, 0, 0], 0)).toBe(false);
  });

  it('keeps one draw call per mesh and a triangle budget', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'public/temporal-bone/manifest.json'), 'utf8')) as {
      structures: { id: string; file: string; parent?: string }[];
    };
    const parents = new Set(manifest.structures.map((item) => item.parent).filter((id): id is string => Boolean(id)));
    let worst = 0;
    let draws = 0;
    for (const structure of manifest.structures) {
      const file = resolve(models, structure.file.replace(/^models\//, ''));
      expect(primitives(file), structure.id).toBe(1);
      if (parents.has(structure.id)) continue;
      worst += triangles(file);
      draws += 1;
    }
    for (const name of ['skull.glb', 'auricle.glb']) {
      const file = resolve(upper, name);
      expect(primitives(file), name).toBe(1);
      worst += triangles(file);
      draws += 1;
    }
    // Leaves + skull + auricle. One outline and the ear hotspot can add two more draws.
    expect(draws).toBeLessThanOrEqual(32);
    expect(worst).toBeLessThanOrEqual(280_000);
    expect(worst).toBeGreaterThan(80_000);
  });

  it('decimates the heavy envelopes and leaves ossicles and nerve segments whole', () => {
    const bone = triangles(resolve(models, 'bone.glb'));
    const sinus = triangles(resolve(models, 'sinus-dura.glb'));
    expect(bone).toBeGreaterThan(40_000);
    expect(bone).toBeLessThanOrEqual(100_000);
    expect(sinus).toBeGreaterThan(8_000);
    expect(sinus).toBeLessThanOrEqual(25_000);
    expect(readFileSync(resolve(models, 'bone.glb')).byteLength).toBeLessThan(500_000);
    for (const [name, count] of Object.entries(LOCKED)) {
      expect(triangles(resolve(models, name)), name).toBe(count);
    }
    expect(triangles(resolve(upper, 'skull.glb'))).toBe(27200);
    expect(triangles(resolve(upper, 'auricle.glb'))).toBe(1527);
  });

  it('renders on demand, with shadows off and a moving pixel-ratio cap', () => {
    const source = readFileSync(resolve(root, 'src/shared/viewer/Viewer.ts'), 'utf8');
    expect(source).not.toContain('setAnimationLoop');
    expect(source).toContain('requestAnimationFrame');
    expect(source).toContain('choosePixelRatio');
    expect(source).toContain('shadowMap.enabled = false');
    expect(source).not.toContain('EffectComposer');
  });
});
