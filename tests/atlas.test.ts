import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { illustrationRamp } from '../src/shared/viewer/netter-material';
import { STRUCTURE_COLOR } from '../src/shared/palette';

function channel(hex: string, index: number): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (n >> (16 - index * 8)) & 255;
}

describe('atlas palette', () => {
  it('keeps facial-nerve segments on distinct yellows', () => {
    const ids = ['fn-meatal', 'fn-labyrinthine', 'fn-geniculate', 'fn-tympanic', 'fn-second-genu', 'fn-mastoid'];
    const lits = ids.map((id) => illustrationRamp(id, STRUCTURE_COLOR[id]).lit);
    expect(new Set(lits).size).toBe(lits.length);
    for (const lit of lits) {
      expect(channel(lit, 0)).toBeGreaterThan(120);
      expect(channel(lit, 1)).toBeGreaterThan(80);
      expect(channel(lit, 2)).toBeLessThan(channel(lit, 0));
    }
  });

  it('paints bone ivory, fluid spaces blue, and reserves a muscle red-brown', () => {
    const bone = illustrationRamp('bone', '#F3F0E6');
    expect(channel(bone.lit, 0)).toBeGreaterThan(channel(bone.lit, 2));
    expect(channel(bone.shadow, 0)).toBeGreaterThan(channel(bone.shadow, 2));
    const fluid = ['labyrinth', 'vestibule', 'scala-tympani', 'scala-vestibuli', 'scc-lateral', 'scc-superior', 'scc-posterior', 'common-crus'];
    const blues = fluid.map((id) => illustrationRamp(id, '#888888').lit);
    expect(new Set(blues).size).toBe(blues.length);
    for (const lit of blues) {
      expect(channel(lit, 2)).toBeGreaterThan(channel(lit, 0));
    }
    const muscle = illustrationRamp('muscle', '#000000');
    expect(channel(muscle.lit, 0)).toBeGreaterThan(channel(muscle.lit, 1));
    expect(channel(muscle.lit, 0)).toBeGreaterThan(channel(muscle.lit, 2));
  });

  it('ships a decimated CC0 skin mesh', () => {
    const root = resolve(import.meta.dirname, '..');
    const skin = JSON.parse(readFileSync(resolve(root, 'public/models/upper-body/skin.json'), 'utf8')) as {
      license: string;
      triangles: number;
      review: string;
    };
    expect(skin.license).toBe('CC0-1.0');
    expect(skin.review).toBe('미검증');
    expect(skin.triangles).toBeLessThanOrEqual(30000);
    const buf = readFileSync(resolve(root, 'public/models/upper-body/skin.glb'));
    const jsonLength = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8')) as {
      accessors: { count: number; type: string }[];
      extensionsRequired?: string[];
    };
    expect(json.extensionsRequired).toContain('KHR_draco_mesh_compression');
    expect(json.accessors[0].count / 3).toBe(skin.triangles);
  });
});
