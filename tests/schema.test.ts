import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REVIEW_STATUSES, type Manifest, type PresetFile, type StructureContent } from '../src/shared/types';
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
    expect(manifest.viewer_offset_mm.every((value) => value < 0)).toBe(true);
    expect(manifest.specimen.geometry).toBe('openear');
    expect(manifest.structures.every((structure) => structure.status === '미검증')).toBe(true);
  });

  it('rejects a structure scale', () => {
    const broken = structuredClone(manifest) as unknown as { structures: Record<string, unknown>[] };
    broken.structures[0]!.scale = 0.01;
    expect(validateManifest(broken).some((issue) => issue.message.includes('scale'))).toBe(true);
  });

  it('validates every content file in the draft shape', () => {
    const pending = new Set(['bone', 'tympanic-membrane', 'external-auditory-canal', 'cochleovestibular-nerve']);
    for (const structure of manifest.structures) {
      const content = readJson(resolve(data, structure.content)) as StructureContent;
      expect(validateContent(content, structure.id, knownIds), structure.id).toEqual([]);
      expect(content.model_version).toBe(manifest.model_version);
      expect(content.review).toBe('미검증');
      expect(content.anatomy.ko.length).toBeGreaterThan(0);
      expect(content.function.ko.length).toBeGreaterThan(0);
      if (pending.has(structure.id)) expect(content.anatomy.ko).toContain('[샘플]');
      else expect(content.anatomy.ko).not.toContain('[샘플]');
      for (const point of content.surgical_points) {
        expect(point.position_mm).toBeUndefined();
        expect(point.text.ko.length).toBeGreaterThan(0);
      }
      expect(existsSync(resolve(data, structure.file))).toBe(true);
    }
  });

  it('links chorda tympani to the facial nerve', () => {
    const chorda = readJson(resolve(data, 'content/chorda-tympani.json')) as StructureContent;
    const facial = readJson(resolve(data, 'content/facial-nerve.json')) as StructureContent;
    expect(chorda.related).toEqual(['facial-nerve']);
    expect(facial.related).toContain('chorda-tympani');
  });

  it('rejects content without a review state', () => {
    const content = readJson(resolve(data, 'content/malleus.json')) as StructureContent;
    const broken = structuredClone(content) as unknown as { review?: string };
    delete broken.review;
    expect(validateContent(broken, 'malleus').some((issue) => issue.path === 'review')).toBe(true);
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

  it('keeps Draco meshes in original millimetres, without a node scale', () => {
    for (const structure of manifest.structures) {
      const buf = readFileSync(resolve(data, structure.file));
      const jsonLength = buf.readUInt32LE(12);
      const json = buf.subarray(20, 20 + jsonLength).toString('utf8');
      expect(json, structure.id).toContain('KHR_draco_mesh_compression');
      const doc = gltf(resolve(data, structure.file));
      expect(doc.nodes?.[0]?.scale).toBeUndefined();
      const position = doc.accessors.find((accessor) => accessor.type === 'VEC3' && accessor.min && accessor.max);
      expect(position?.min && position.max).toBeTruthy();
      const values = [...position!.min!, ...position!.max!];
      expect(values.some((value) => Math.abs(value) > 1)).toBe(true);
      expect(values.every((value) => Math.abs(value) < 120)).toBe(true);
    }
  });

  it('validates presets and the CT volume, and every slice file exists', () => {
    const presets = readJson(resolve(data, 'presets.json')) as PresetFile;
    const volume = readJson(resolve(data, 'ct/volume.json')) as {
      dims: number[];
      spacing_mm: number[];
      index_digits: number;
      file_extension: string;
      texture_flip_y: boolean;
      planes: Record<string, { axis: number; folder: string }>;
      model_version: string;
    };
    expect(validatePresets(presets, knownIds)).toEqual([]);
    const mastoidectomy = presets.sequences.find((sequence) => sequence.id === 'mastoidectomy');
    expect(mastoidectomy?.steps.map((step) => step.id)).toEqual([
      'cortical-mastoidectomy',
      'antrum',
      'identify-facial-nerve',
      'posterior-tympanotomy',
    ]);
    expect(mastoidectomy?.steps[3]?.danger).toEqual(['facial-nerve', 'chorda-tympani']);
    expect(validateVolume(volume)).toEqual([]);
    expect(volume.model_version).toBe(manifest.model_version);
    expect(volume.texture_flip_y).toBe(false);
    expect(volume.spacing_mm).toEqual([0.25, 0.25, 0.25]);
    expect(volume.planes.axial?.axis).toBe(2);
    expect(volume.planes.coronal?.axis).toBe(1);
    expect(volume.planes.sagittal?.axis).toBe(0);
    const sinus = manifest.layers.find((layer) => layer.id === 'sinus');
    expect(sinus?.opacity).toBeLessThan(0.5);
    expect(sinus?.name.ko).toContain('S상정맥동');
    const antrum = mastoidectomy?.steps.find((step) => step.id === 'antrum');
    expect(antrum?.identify).toEqual([]);
    expect(antrum?.marker?.review).toBe('미검증');
    expect(antrum?.marker?.source?.length ?? 0).toBeGreaterThan(0);
    expect(antrum?.highlight).toBeUndefined();
    for (const step of mastoidectomy?.steps ?? []) {
      expect(step.hidden).toEqual(expect.arrayContaining(['scala-vestibuli', 'scala-tympani']));
    }
    expect(manifest.missing_structures?.map((item) => item.name)).toEqual(expect.arrayContaining(['Jugular bulb']));
    expect(manifest.missing_structures?.some((item) => item.name === 'Semicircular canals')).toBe(false);
    for (const plane of Object.values(volume.planes)) {
      for (let index = 0; index < volume.dims[plane.axis]!; index += 1) {
        const file = resolve(data, plane.folder, `${String(index).padStart(volume.index_digits, '0')}.${volume.file_extension}`);
        expect(existsSync(file), file).toBe(true);
      }
    }
  });

  it('only allows the two review statuses', () => {
    expect(REVIEW_STATUSES).toEqual(['미검증', 'YS 검수 완료']);
  });
});
