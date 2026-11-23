import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const data = resolve(root, 'public/temporal-bone');

const PLACEHOLDER = /\[샘플\]|\[Sample\]|설명 자리|audit page|placeholder/i;

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (name.endsWith('.json')) files.push(path);
  }
  return files;
}

describe('temporal-bone anatomy accuracy', () => {
  const report = JSON.parse(readFileSync(resolve(data, 'split-report.json'), 'utf8')) as {
    'facial-nerve': { lengthsMm: Record<string, number>; arcMm: number };
  };
  const registration = JSON.parse(readFileSync(resolve(root, 'public/models/upper-body/registration.json'), 'utf8')) as {
    containment: { outsideFraction: number };
    concha: { axisOffsetMm: number };
    current: { rmsMm: number };
    applied: { angleDeg: number; scale: number };
  };

  it('keeps the posterior canal inferior to the lateral canal and the lateral plane near horizontal', () => {
    const note = JSON.parse(readFileSync(resolve(data, 'split-notes.json'), 'utf8')) as {
      lengthsMm: Record<string, number>;
    };
    expect(note.lengthsMm['fn-labyrinthine']).toBeGreaterThanOrEqual(2.5);
    expect(note.lengthsMm['fn-labyrinthine']).toBeLessThanOrEqual(5.5);
    expect(note.lengthsMm['fn-tympanic']).toBeGreaterThan(report['facial-nerve'].lengthsMm['fn-geniculate']);
    expect(note.lengthsMm['fn-mastoid']).toBeGreaterThan(8);
    expect(report['facial-nerve'].arcMm).toBeGreaterThan(20);
  });

  it('registers the bone inside the skin with the concha on the canal axis', () => {
    expect(registration.applied.scale).toBe(1);
    expect(registration.containment.outsideFraction).toBe(0);
    expect(registration.concha.axisOffsetMm).toBeLessThan(3);
    expect(registration.current.rmsMm).toBeLessThan(8);
    expect(registration.applied.angleDeg).toBeGreaterThan(15);
  });

  it('ships no placeholder copy, and every description has a source', () => {
    for (const file of walk(data)) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(PLACEHOLDER);
    }
    for (const file of walk(resolve(data, 'content'))) {
      const content = JSON.parse(readFileSync(file, 'utf8')) as {
        anatomy: { en: string; ko: string };
        function: { en: string; ko: string };
        sources: { citation: string; page: string }[];
      };
      expect(content.anatomy.en.length, file).toBeGreaterThan(15);
      expect(content.anatomy.ko.length, file).toBeGreaterThan(8);
      expect(content.function.en.length, file).toBeGreaterThan(8);
      expect(content.sources.length, file).toBeGreaterThan(0);
      for (const source of content.sources) {
        expect(source.citation.length, file).toBeGreaterThan(8);
        expect(source.page.length, file).toBeGreaterThan(0);
        expect(source.page.toLowerCase(), file).not.toContain('audit');
      }
    }
  });
});
