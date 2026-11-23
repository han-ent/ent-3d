import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const data = resolve(root, 'public/temporal-bone');

function accessorCount(file: string): number {
  const buf = readFileSync(file);
  const jsonLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8')) as {
    accessors: { type: string; count: number; min?: number[] }[];
  };
  const position = json.accessors.find((accessor) => accessor.type === 'VEC3' && accessor.min);
  return position?.count ?? 0;
}

describe('mesh split integrity', () => {
  const report = JSON.parse(readFileSync(resolve(data, 'split-report.json'), 'utf8')) as {
    labyrinth: { parentVertices: number; exclusiveSum: number; children: Record<string, { exclusiveVertices: number }> };
    'scala-tympani': { parentVertices: number; exclusiveSum: number; children: Record<string, { exclusiveVertices: number }> };
    'scala-vestibuli': { parentVertices: number; exclusiveSum: number; children: Record<string, { exclusiveVertices: number }> };
    'facial-nerve': { parentVertices: number; exclusiveSum: number; children: Record<string, { exclusiveVertices: number }> };
    'tympanic-membrane': { parentVertices: number; exclusiveSum: number; children: Record<string, { exclusiveVertices: number }> };
    landmarkCount: number;
  };

  it('makes each child partition add up to the parent vertex count', () => {
    for (const group of ['labyrinth', 'scala-tympani', 'scala-vestibuli', 'facial-nerve', 'tympanic-membrane'] as const) {
      const entry = report[group];
      const sum = Object.values(entry.children).reduce((total, child) => total + child.exclusiveVertices, 0);
      expect(sum, group).toBe(entry.parentVertices);
      expect(entry.exclusiveSum).toBe(entry.parentVertices);
    }
    expect(Object.keys(report['facial-nerve'].children)).toEqual([
      'fn-geniculate',
      'fn-labyrinthine',
      'fn-tympanic',
      'fn-second-genu',
      'fn-mastoid',
    ]);
    expect(report.landmarkCount).toBeGreaterThanOrEqual(35);
  });

  it('writes a Draco mesh for every child', () => {
    const names = [
      ...Object.keys(report.labyrinth.children),
      ...Object.keys(report['scala-tympani'].children),
      ...Object.keys(report['scala-vestibuli'].children),
      ...Object.keys(report['facial-nerve'].children),
      ...Object.keys(report['tympanic-membrane'].children),
    ];
    for (const name of names) {
      const file = resolve(data, 'models', `${name}.glb`);
      const text = readFileSync(file).toString('utf8');
      expect(text, name).toContain('KHR_draco_mesh_compression');
      expect(accessorCount(file), name).toBeGreaterThan(10);
    }
  });
});
