import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseStudyLabels, labelAllowed, type StudyLabel } from '../src/shared/labels';
import { buildSearchIndex, searchEntries } from '../src/shared/search-index';
import { nextSnap, sheetCoverPx, snapAfterDrag } from '../src/shared/sheet-snap';
import { boxFitsView, frameAabb, INNER_CORE, STAGE_VIEW, stagesForLandmark } from '../src/shared/stage-frame';
import { CANAL_WALL, labelAnchorPoint, structureLabelAnchor } from '../src/shared/surface-anchor';
import en from '../src/shared/i18n/en.json';
import ko from '../src/shared/i18n/ko.json';
import type { PresetFile } from '../src/shared/types';
import { isOutsideAabb, verticalSpanMm } from '../src/shared/view-pose';

const root = resolve(import.meta.dirname, '..');

describe('stage cameras', () => {
  const bone = { min: [-19.12, 6.12, 25.27] as [number, number, number], max: [66.84, 69.72, 81.86] as [number, number, number] };
  const inner = { min: [22, 20, 48] as [number, number, number], max: [38, 40, 80] as [number, number, number] };

  it('frames the temporal bone outside the cortex on a phone and a desktop', () => {
    for (const [width, height] of [
      [390, 844],
      [1280, 800],
    ] as const) {
      const pose = frameAabb({
        box: bone,
        direction: STAGE_VIEW.bone.direction,
        up: STAGE_VIEW.bone.up,
        fovDeg: STAGE_VIEW.bone.fov,
        viewWidthPx: width,
        viewHeightPx: height,
        margin: STAGE_VIEW.bone.margin,
      });
      expect(isOutsideAabb(pose.position, bone.min, bone.max), `${width}x${height}`).toBe(true);
      expect(verticalSpanMm(pose.distance, STAGE_VIEW.bone.fov), `${width}x${height}`).toBeGreaterThan(50);
      expect(boxFitsView(bone, pose.position, pose.target, STAGE_VIEW.bone.up, STAGE_VIEW.bone.fov, width, height)).toBe(true);
    }
  });

  it('keeps the inner-ear target inside a tall phone', () => {
    const pose = frameAabb({
      box: inner,
      direction: STAGE_VIEW.inner.direction,
      up: STAGE_VIEW.inner.up,
      fovDeg: 32,
      viewWidthPx: 390,
      viewHeightPx: 844,
      margin: STAGE_VIEW.inner.margin,
    });
    expect(isOutsideAabb(pose.position, inner.min, inner.max)).toBe(true);
    expect(pose.target[2]).toBeGreaterThan(50);
    expect(boxFitsView(inner, pose.position, pose.target, STAGE_VIEW.inner.up, 32, 390, 844)).toBe(true);
    expect(verticalSpanMm(pose.distance, 32)).toBeGreaterThan(20);
  });
});

describe('label mode precedence', () => {
  const landmarks = JSON.parse(readFileSync(resolve(root, 'public/temporal-bone/landmarks.json'), 'utf8')) as {
    landmarks: { id: string; en: string; ko: string; confidence?: string; parent?: string; surgical?: boolean; xyz_mm: [number, number, number] }[];
  };

  it('keeps every placed landmark eligible in surgical mode at mastoidectomy distance', () => {
    const placed = landmarks.landmarks.filter((item) => item.confidence === 'placed');
    expect(placed).toHaveLength(42);
    for (const item of placed) {
      const stage = stagesForLandmark(item.id)[0] ?? 'bone';
      const label: StudyLabel = {
        id: item.id,
        text: item.en,
        en: item.en,
        ko: item.ko,
        tier: 'subpart',
        modes: ['surgical', 'all'],
        priority: 70,
        parentId: item.parent,
        position: item.xyz_mm,
        stages: [stage],
      };
      expect(labelAllowed(label, 'surgical', 160, null, stage), item.id).toBe(true);
      expect(labelAllowed(label, 'surgical', 40, null, stage), item.id).toBe(true);
    }
  });

  it('does not collapse all-terms to group headings when the camera is far', () => {
    const labels: StudyLabel[] = [
      ...['ossicles', 'inner', 'nerve', 'middle'].map((id, index) => ({
        id,
        text: id,
        en: id,
        ko: id,
        tier: 'region' as const,
        modes: ['basic', 'all'] as StudyLabel['modes'],
        priority: 30 - index,
        position: [0, 0, 0] as [number, number, number],
        stages: ['bone' as const],
      })),
      ...['malleus', 'incus', 'stapes', 'facial-nerve', 'scc-lateral', 'bone'].map((id, index) => ({
        id,
        text: id,
        en: id,
        ko: id,
        tier: 'structure' as const,
        modes: ['basic', 'all'] as StudyLabel['modes'],
        priority: 50 - index,
        position: [0, 0, 0] as [number, number, number],
        stages: ['bone' as const],
      })),
    ];
    const shown = chooseStudyLabels(labels as StudyLabel[], 'all', 160, null, 'bone', null);
    expect(shown.some((label) => label.tier === 'structure')).toBe(true);
    expect(shown.filter((label) => label.tier === 'region').length).toBeLessThan(shown.length);
    const surgical = chooseStudyLabels(
      landmarks.landmarks
        .filter((item) => item.confidence === 'placed')
        .map((item) => ({
          id: item.id,
          text: item.en,
          en: item.en,
          ko: item.ko,
          tier: 'subpart' as const,
          modes: ['surgical', 'all'] as const,
          priority: 70,
          position: item.xyz_mm,
          stages: stagesForLandmark(item.id),
        })),
      'surgical',
      150,
      null,
      'bone',
      'posterior-tympanotomy',
    );
    expect(surgical.length).toBe(0);
  });
});

describe('search aliases', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'public/temporal-bone/manifest.json'), 'utf8')) as {
    structures: { id: string; name: { en: string; ko: string }; parent?: string }[];
  };
  const landmarks = JSON.parse(readFileSync(resolve(root, 'public/temporal-bone/landmarks.json'), 'utf8')) as {
    landmarks: { id: string; en: string; ko: string; parent?: string }[];
  };
  const terms = JSON.parse(readFileSync(resolve(root, 'public/shared/terms.json'), 'utf8')) as {
    terms: { en: string; ko: string; aliases?: string[] }[];
  };
  const index = buildSearchIndex(
    manifest.structures.map((item) => ({ id: item.id, en: item.name.en, ko: item.name.ko, parentId: item.parent })),
    landmarks.landmarks.map((item) => ({ id: item.id, en: item.en, ko: item.ko, parentId: item.parent })),
    terms.terms,
  );

  it('finds cochlea, round window, Korean round window, and the jugular bulb', () => {
    expect(searchEntries(index, 'cochlea').length).toBeGreaterThan(0);
    expect(searchEntries(index, 'round').some((hit) => hit.id === 'round-window')).toBe(true);
    expect(searchEntries(index, '정원창').some((hit) => hit.id === 'round-window')).toBe(true);
    expect(searchEntries(index, 'jugular').some((hit) => hit.id === 'jugular-bulb')).toBe(true);
  });
});

describe('canal wall anchors', () => {
  const cube: number[] = [];
  const add = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => {
    cube.push(...a, ...b, ...c);
  };
  add([1, -1, -1], [1, 1, -1], [1, 1, 1]);
  add([1, -1, -1], [1, 1, 1], [1, -1, 1]);
  add([-1, -1, -1], [-1, 1, 1], [-1, 1, -1]);
  add([-1, -1, -1], [-1, -1, 1], [-1, 1, 1]);

  it('keeps a centroid that is inside the mesh and moves one that is not', () => {
    expect(labelAnchorPoint([0, 0.2, 0], cube, null)).toEqual([0, 0.2, 0]);
    const outside = labelAnchorPoint([5, 0.2, 0], cube, null);
    expect(outside[0]).toBeCloseTo(1);
    expect(Math.hypot(outside[1], outside[2])).toBeLessThan(1.5);
  });

  it('anchors each semicircular canal on its arch landmark', () => {
    const landmarks = JSON.parse(readFileSync(resolve(root, 'public/temporal-bone/landmarks.json'), 'utf8')) as {
      landmarks: { id: string; xyz_mm: [number, number, number] }[];
    };
    const walls = Object.fromEntries(landmarks.landmarks.map((item) => [item.id, item.xyz_mm]));
    for (const [structure, wall] of Object.entries(CANAL_WALL)) {
      const anchor = structureLabelAnchor(structure, [0, 0, 0], walls);
      expect(anchor, structure).toEqual(walls[wall]);
      expect(anchor).not.toEqual([0, 0, 0]);
    }
  });
});

describe('view preset copy', () => {
  it('keeps the on-screen line short and the explanation for the sheet', () => {
    expect(en['presets.viewPresetShort']).toBe('View preset · not actual drilling');
    expect(ko['presets.viewPresetShort']).toBe('시점 프리셋 · 실제 드릴링 아님');
    expect(en['presets.viewPreset'].length).toBeGreaterThan(en['presets.viewPresetShort'].length);
    expect(ko['presets.viewPreset']).toContain('평면');
  });
});

describe('bottom sheet snaps', () => {
  it('moves between peek, half, and full', () => {
    expect(nextSnap('peek')).toBe('half');
    expect(nextSnap('full')).toBe('peek');
    expect(snapAfterDrag('peek', -400, 844)).toBe('full');
    expect(snapAfterDrag('full', 400, 844)).toBe('peek');
    expect(sheetCoverPx('half', 844)).toBeGreaterThan(sheetCoverPx('peek', 844));
    expect(sheetCoverPx('peek', 844)).toBeLessThan(200);
  });
});

describe('dissection steps', () => {
  const presets = JSON.parse(readFileSync(resolve(root, 'public/temporal-bone/presets.json'), 'utf8')) as PresetFile;
  const step = (id: string) => presets.sequences.flatMap((sequence) => sequence.steps).find((item) => item.id === id);

  it('opens a different field at each mastoid step and shows the cochlea from above', () => {
    const cortical = step('cortical-mastoidectomy');
    const antrum = step('antrum');
    const facial = step('identify-facial-nerve');
    const posterior = step('posterior-tympanotomy');
    const fossa = step('mcf-view');
    expect(cortical?.visible).not.toEqual(expect.arrayContaining(['malleus', 'incus', 'stapes']));
    expect(cortical?.hidden).toEqual(expect.arrayContaining(['malleus', 'incus', 'stapes']));
    const corticalDelta = cortical!.camera.position.map((value, index) => value - cortical!.camera.target[index]);
    expect(Math.abs(corticalDelta[2]!)).toBeGreaterThan(Math.abs(corticalDelta[0]!));
    expect(antrum?.visible).toEqual(expect.arrayContaining(['scc-lateral', 'incus']));
    expect(antrum?.visible ?? []).not.toEqual(expect.arrayContaining(['facial-nerve', 'chorda-tympani']));
    expect(antrum?.hidden).toEqual(expect.arrayContaining(['facial-nerve', 'chorda-tympani']));
    expect(facial?.visible).toEqual(expect.arrayContaining(['incus', 'facial-nerve']));
    expect(INNER_CORE).toEqual(['cochlea', 'vestibule', 'scc-lateral', 'scc-superior', 'scc-posterior', 'iac', 'facial-nerve']);
    const css = readFileSync(resolve(root, 'src/styles/app.css'), 'utf8');
    const handle = css.slice(css.indexOf('.sheet-handle'), css.indexOf('.sheet-handle') + 320);
    expect(handle).toMatch(/touch-action:\s*none/);
    expect(antrum?.clipping?.constant).not.toBe(facial?.clipping?.constant);
    expect(facial?.clipping?.constant).not.toBe(posterior?.clipping?.constant);
    expect(posterior?.instructions.en.toLowerCase()).toContain('stapes');
    expect(posterior?.instructions.en.toLowerCase()).toContain('round');
    expect(posterior?.instructions.ko).toContain('정원창');
    expect(posterior?.instructions.en.toLowerCase()).not.toContain('incus between');
    expect(fossa?.ghosted).toContain('bone');
    expect(fossa?.clipping?.enabled).toBe(true);
    expect(fossa?.visible).toEqual(expect.arrayContaining(['scala-vestibuli', 'scala-tympani']));
    expect(fossa?.hidden ?? []).not.toEqual(expect.arrayContaining(['scala-vestibuli']));
  });
});
