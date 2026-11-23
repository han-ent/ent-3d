import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const data = resolve(root, 'public/temporal-bone');

const PLACEHOLDER = /\[샘플\]|\[Sample\]|설명 자리|audit page|placeholder/i;
const PROCESSING =
  /this mesh|not a separate|not split|not segmented|angle split|\bwas split\b|\bwere split\b|unsplit|이번에 연|확인하지 못해|이번 회차|이 메시|메시는 없|유양동 메시/i;

type Landmark = { id: string; anatomy: string; clinical: string; xyz_mm: [number, number, number] };
type Axis = [number, number, number];

function dot(point: [number, number, number], origin: [number, number, number], axis: Axis): number {
  return (point[0] - origin[0]) * axis[0] + (point[1] - origin[1]) * axis[1] + (point[2] - origin[2]) * axis[2];
}

function userFacingText(value: unknown, skip: Set<string>, path: string, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => userFacingText(item, skip, `${path}[${index}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (skip.has(key)) continue;
      userFacingText(child, skip, `${path}.${key}`, out);
    }
  }
}

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
    concha: { axisOffsetMm: number; porusBehindConchaMm: number };
    skullFit: { outsideOver3mmFraction: number };
    mastoidTipGapMm: number;
    current: { rmsMm: number; pairs: { id: string; skullMm: Axis }[] };
    applied: { angleDeg: number; scale: number; maps: string };
    canalPlanes: { lateralToFrankfortDeg: number; superiorToSagittalDeg: number; posteriorToSagittalDeg: number };
    headAxes: { anterior: Axis; inferior: Axis; lateral: Axis };
  };

  it('puts the first genu at the anterior tip and the labyrinthine segment at the fundus', () => {
    const note = JSON.parse(readFileSync(resolve(data, 'split-notes.json'), 'utf8')) as {
      lengthsMm: Record<string, number>;
      firstGenuMm: number;
    };
    expect(note.lengthsMm['fn-meatal']).toBeUndefined();
    expect(note.firstGenuMm).toBeLessThan(1.5);
    expect(note.lengthsMm['fn-labyrinthine']).toBeGreaterThan(1.5);
    expect(note.lengthsMm['fn-labyrinthine']).toBeLessThan(4.5);
    expect(note.lengthsMm['fn-tympanic']).toBeGreaterThan(7);
    expect(note.lengthsMm['fn-tympanic']).toBeLessThan(14);
    expect(note.lengthsMm['fn-geniculate']).toBeGreaterThan(0.8);
    expect(note.lengthsMm['fn-geniculate']).toBeLessThanOrEqual(2);
    expect(note.lengthsMm['fn-mastoid']).toBeGreaterThan(8);
    expect(report['facial-nerve'].arcMm).toBeGreaterThan(20);
    const mastoid = JSON.parse(readFileSync(resolve(data, 'content/fn-mastoid.json'), 'utf8')) as {
      function: { en: string; ko: string };
    };
    expect(mastoid.function.en).toContain('3.5 mm');
    expect(mastoid.function.en).not.toMatch(/20 mm short/i);
    expect(mastoid.function.ko).not.toContain('유양돌기 첨부');
  });

  it('keeps the head upright and the canal planes in range', () => {
    expect(registration.applied.scale).toBe(1);
    expect(registration.applied.maps).toBe('specimen-to-upright-head');
    expect(registration.containment.outsideFraction).toBe(0);
    expect(registration.concha.porusBehindConchaMm).toBeLessThan(-2);
    expect(registration.skullFit.outsideOver3mmFraction).toBeLessThan(0.03);
    expect(registration.mastoidTipGapMm).toBeLessThan(8);
    expect(registration.current.rmsMm).toBeGreaterThan(0);
    expect(registration.current.rmsMm).toBeLessThan(18);
    expect(registration.applied.angleDeg).toBeGreaterThan(15);
    expect(registration.canalPlanes.lateralToFrankfortDeg).toBeGreaterThanOrEqual(25);
    expect(registration.canalPlanes.lateralToFrankfortDeg).toBeLessThanOrEqual(30);
    expect(registration.canalPlanes.superiorToSagittalDeg).toBeGreaterThanOrEqual(40);
    expect(registration.canalPlanes.superiorToSagittalDeg).toBeLessThanOrEqual(55);
    expect(registration.canalPlanes.posteriorToSagittalDeg).toBeGreaterThanOrEqual(40);
    expect(registration.canalPlanes.posteriorToSagittalDeg).toBeLessThanOrEqual(55);
    const skull = registration.current.pairs.map((pair) => pair.skullMm.join(','));
    expect(new Set(skull).size).toBe(skull.length);
    expect(registration.current.pairs.some((pair) => pair.id === 'styloid-base' || pair.id === 'henle-spine')).toBe(false);
  });

  it('checks landmark sides against the head axes', () => {
    const landmarks = JSON.parse(readFileSync(resolve(data, 'landmarks.json'), 'utf8')) as { landmarks: Landmark[] };
    const by = Object.fromEntries(landmarks.landmarks.map((item) => [item.id, item.xyz_mm]));
    const { anterior, inferior, lateral } = registration.headAxes;
    expect(dot(by['cochleariform-process'], by['geniculate-ganglion'], anterior)).toBeLessThan(0);
    expect(dot(by['cochleariform-process'], by['geniculate-ganglion'], inferior)).toBeGreaterThan(0);
    expect(dot(by['cochleariform-process'], by['stapes-footplate'], inferior)).toBeLessThan(0);
    expect(dot(by['pyramidal-eminence'], by['second-genu'], anterior)).toBeGreaterThan(1);
    expect(dot(by['pyramidal-eminence'], by['second-genu'], lateral)).toBeLessThan(0);
    expect(dot(by['sinodural-angle'], by.tegmen, anterior)).toBeLessThan(-4);
    expect(Math.abs(dot(by['sinodural-angle'], by.tegmen, inferior))).toBeLessThan(8);
    expect(dot(by['sinodural-angle'], by['mastoid-antrum'], anterior)).toBeLessThan(0);
    expect(dot(by['geniculate-ganglion'], by['meatal-segment'], anterior)).toBeGreaterThan(0.5);
    const styloidDrop = dot(by['styloid-base'], by['stylomastoid-foramen'], inferior);
    expect(styloidDrop).toBeGreaterThan(2);
    expect(styloidDrop).toBeLessThan(12);
    expect(dot(by['stapes-anterior-crus'], by['stapes-posterior-crus'], anterior)).toBeGreaterThan(0);
    const [hx, hy, hz] = by['stapes-head'];
    const [cx, cy, cz] = by['stapes-anterior-crus'];
    const crusGap = Math.hypot(cx - hx, cy - hy, cz - hz);
    expect(crusGap).toBeGreaterThan(1.6);
  });

  it('keeps auricle labels apart and in anatomical order', () => {
    const surface = JSON.parse(readFileSync(resolve(data, 'surface-anatomy.json'), 'utf8')) as {
      labels: { id: string; xyz_mm: [number, number, number] }[];
    };
    const by = Object.fromEntries(surface.labels.map((item) => [item.id, item.xyz_mm]));
    const ids = Object.keys(by);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const [ax0, ay, az] = by[ids[i]];
        const [bx, byy, bz] = by[ids[j]];
        const gap = Math.hypot(ax0 - bx, ay - byy, az - bz);
        expect(gap, `${ids[i]} ${ids[j]}`).toBeGreaterThan(2.5);
      }
    }
    const { anterior, inferior, lateral } = registration.headAxes;
    const behindTragus = -dot(by.cavum, by.tragus, anterior);
    expect(behindTragus).toBeGreaterThan(6);
    expect(behindTragus).toBeLessThan(16);
    expect(dot(by.cymba, by['crus-helix'], inferior)).toBeLessThan(0);
    expect(dot(by.antihelix, by.cymba, anterior)).toBeLessThan(0);
    expect(dot(by.antihelix, by.cymba, lateral)).toBeGreaterThan(0);
    expect(dot(by.antitragus, by.tragus, anterior)).toBeLessThan(0);
    expect(dot(by.antitragus, by.tragus, inferior)).toBeGreaterThan(0);
    expect(Math.hypot(
      by.antitragus[0] - by.tragus[0],
      by.antitragus[1] - by.tragus[1],
      by.antitragus[2] - by.tragus[2],
    )).toBeLessThan(15);
    expect(dot(by['postauricular-sulcus'], by.helix, anterior)).toBeLessThan(0);
    expect(dot(by['postauricular-sulcus'], by.helix, lateral)).toBeLessThan(0);
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

  it('keeps processing notes out of the copy a reader sees', () => {
    const skip = new Set(['method', 'meshLimited', 'tmMethod', 'scaleDecision', 'frameNote', 'geometry']);
    const files = [
      ...walk(resolve(data, 'content')),
      resolve(data, 'landmarks.json'),
      resolve(data, 'surface-anatomy.json'),
      resolve(data, 'ct-labels.json'),
      resolve(data, 'presets.json'),
      resolve(data, 'manifest.json'),
    ];
    for (const file of files) {
      const payload = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      const texts: string[] = [];
      userFacingText(payload, skip, file, texts);
      for (const text of texts) {
        expect(text, file).not.toMatch(PROCESSING);
      }
    }
  });
});
