import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REVIEW_STATUSES, type Manifest, type StructureContent } from '../src/shared/types';
import { validateContent, validateManifest, validatePresets, validateVolume } from '../src/shared/schema';

const root = resolve(import.meta.dirname, '..');
const data = resolve(root, 'public/temporal-bone');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function gltf(path: string): { nodes?: { name?: string; scale?: number[] }[]; accessors: { min?: number[]; max?: number[]; type: string }[] } {
  const buf = readFileSync(path);
  expect(buf.readUInt32LE(0)).toBe(0x46546c67);
  expect(buf.readUInt32LE(16)).toBe(0x4e4f534a);
  const length = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + length).toString('utf8'));
}

describe('temporal-bone manifest and content', () => {
  const manifest = readJson(resolve(data, 'manifest.json')) as Manifest;
  const knownIds = new Set(manifest.structures.map((structure) => structure.id));

  it('accepts the manifest', () => {
    expect(validateManifest(manifest)).toEqual([]);
    expect(manifest.model_version).toBe(manifest.specimen.model_version);
    expect(manifest.coordinate_system.units).toBe('mm');
    expect(manifest.viewer_offset_mm).toEqual([0, 0, 0]);
  });

  it('rejects a structure scale', () => {
    const broken = structuredClone(manifest) as unknown as { structures: Record<string, unknown>[] };
    broken.structures[0]!.scale = 0.01;
    expect(validateManifest(broken).some((issue) => issue.message.includes('scale'))).toBe(true);
  });

  it('validates every content file, including function blocks', () => {
    for (const structure of manifest.structures) {
      const content = readJson(resolve(data, structure.content)) as StructureContent;
      expect(validateContent(content, structure.id, knownIds), structure.id).toEqual([]);
      expect(content.model_version).toBe(manifest.model_version);
      expect(content.info.status).toBe('미검증');
      for (const block of [content.function.physiology, content.function.injury, content.function.tests]) {
        expect(block.status).toBe('미검증');
        expect(block.source.length).toBeGreaterThan(0);
        expect(block.text.ko.startsWith('[샘플]')).toBe(true);
      }
      for (const point of content.surgical_points) expect(point.status).toBe('미검증');
      expect(existsSync(resolve(data, structure.file))).toBe(true);
    }
  });

  it('links chorda tympani to the facial nerve', () => {
    const chorda = readJson(resolve(data, 'content/chorda_tympani.json')) as StructureContent;
    const facial = readJson(resolve(data, 'content/facial_nerve.json')) as StructureContent;
    expect(chorda.related).toEqual(['facial_nerve']);
    expect(facial.related).toContain('chorda_tympani');
  });

  it('rejects a function block without its own status', () => {
    const content = readJson(resolve(data, 'content/malleus.json')) as StructureContent;
    const broken = structuredClone(content) as unknown as { function: { physiology: { status?: string } } };
    delete broken.function.physiology.status;
    expect(validateContent(broken, 'malleus').some((issue) => issue.path === 'function.physiology.status')).toBe(true);
  });

  it('rejects a related id that is missing or self', () => {
    const content = readJson(resolve(data, 'content/malleus.json')) as StructureContent;
    const self = structuredClone(content);
    self.related = ['malleus'];
    expect(validateContent(self, 'malleus', knownIds).some((issue) => issue.path.startsWith('related'))).toBe(true);
    const unknown = structuredClone(content);
    unknown.related = ['not-a-structure'];
    expect(validateContent(unknown, 'malleus', knownIds).some((issue) => issue.message.includes('unknown'))).toBe(true);
  });

  it('keeps placeholder meshes in millimetres and labeled SAMPLE', () => {
    for (const structure of manifest.structures) {
      const doc = gltf(resolve(data, structure.file));
      expect(doc.nodes?.[0]?.name).toContain('SAMPLE');
      expect(doc.nodes?.[0]?.scale).toBeUndefined();
      const position = doc.accessors.find((accessor) => accessor.type === 'VEC3' && accessor.min && accessor.max);
      expect(position?.min && position.max).toBeTruthy();
      const values = [...position!.min!, ...position!.max!];
      expect(values.some((value) => Math.abs(value) > 1)).toBe(true);
      expect(values.every((value) => Math.abs(value) < 40)).toBe(true);
    }
  });

  it('validates presets and the CT volume, and every slice file exists', () => {
    const presets = readJson(resolve(data, 'presets.json'));
    const volume = readJson(resolve(data, 'ct/volume.json')) as {
      dims: number[];
      planes: Record<string, { axis: number; folder: string }>;
      model_version: string;
    };
    expect(validatePresets(presets)).toEqual([]);
    expect(validateVolume(volume)).toEqual([]);
    expect(volume.model_version).toBe(manifest.model_version);
    expect(volume.planes.axial?.axis).toBe(1);
    expect(volume.planes.coronal?.axis).toBe(2);
    expect(volume.planes.sagittal?.axis).toBe(0);
    for (const plane of Object.values(volume.planes)) {
      for (let index = 0; index < volume.dims[plane.axis]!; index += 1) {
        const file = resolve(data, plane.folder, `${String(index).padStart(2, '0')}.png`);
        expect(existsSync(file), file).toBe(true);
      }
    }
  });

  it('only allows the two review statuses', () => {
    expect(REVIEW_STATUSES).toEqual(['미검증', 'YS 검수 완료']);
  });
});
