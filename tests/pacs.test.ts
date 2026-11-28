import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { displayedEdgeLabels } from '../src/shared/frame';
import {
  WINDOW_PRESETS,
  consumeDragSteps,
  containedRect,
  displayOfVoxel,
  dragWindowLevel,
  formatSliceOverlay,
  formatWindowOverlay,
  scrollIndex,
} from '../src/shared/pacs';
import type { VolumeMeta } from '../src/shared/types';
import en from '../src/shared/i18n/en.json';
import ko from '../src/shared/i18n/ko.json';

/** Identity stack in the ZETA file frame: +X anterior, +Y inferior, +Z medial (right ear). */
function synthetic(): VolumeMeta {
  return {
    id: 'synthetic',
    label: { ko: '합성', en: 'synthetic' },
    model_version: 'test',
    spacing_mm: [1, 1, 1],
    origin_mm: [0, 0, 0],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    dims: [9, 9, 9],
    voxel_origin: 'center',
    texture_flip_y: false,
    index_digits: 3,
    file_extension: 'webp',
    planes: {
      axial: { axis: 2, folder: 'ct/axial', col_axis: 0, row_axis: 1, row_0_is_max: true },
      coronal: { axis: 1, folder: 'ct/coronal', col_axis: 0, row_axis: 2, row_0_is_max: true },
      sagittal: { axis: 0, folder: 'ct/sagittal', col_axis: 1, row_axis: 2, row_0_is_max: true },
    },
  };
}

describe('PACS orientation on an asymmetric volume', () => {
  const volume = synthetic();
  const anterior = 8;
  const posterior = 0;
  const superior = 0;
  const inferior = 8;
  const patientRight = 0;
  const patientLeft = 8;
  const mid = 4;

  it('shows axial from the feet, with the patient right on the left and anterior up', () => {
    const rightFront = displayOfVoxel(volume, 'coronal', anterior, mid, patientRight);
    const leftBack = displayOfVoxel(volume, 'coronal', posterior, mid, patientLeft);
    expect(rightFront.u).toBeLessThan(leftBack.u);
    expect(rightFront.v).toBeLessThan(leftBack.v);
    expect(rightFront.u).toBeLessThan(0.2);
    expect(rightFront.v).toBeLessThan(0.2);
    expect(displayedEdgeLabels('coronal')).toEqual({ left: 'R', top: 'A', right: 'L', bottom: 'P' });
  });

  it('shows coronal from the front, with the patient right on the left and superior up', () => {
    const rightTop = displayOfVoxel(volume, 'sagittal', mid, superior, patientRight);
    const leftBottom = displayOfVoxel(volume, 'sagittal', mid, inferior, patientLeft);
    expect(rightTop.u).toBeLessThan(leftBottom.u);
    expect(rightTop.v).toBeLessThan(leftBottom.v);
    expect(rightTop.u).toBeLessThan(0.2);
    expect(rightTop.v).toBeLessThan(0.2);
    expect(displayedEdgeLabels('sagittal')).toEqual({ left: 'R', top: 'S', right: 'L', bottom: 'I' });
  });

  it('shows sagittal from the patient left, with anterior on the left and superior up', () => {
    const frontTop = displayOfVoxel(volume, 'axial', anterior, superior, mid);
    const backBottom = displayOfVoxel(volume, 'axial', posterior, inferior, mid);
    expect(frontTop.u).toBeLessThan(backBottom.u);
    expect(frontTop.v).toBeLessThan(backBottom.v);
    expect(frontTop.u).toBeLessThan(0.2);
    expect(frontTop.v).toBeLessThan(0.2);
    expect(displayedEdgeLabels('axial')).toEqual({ left: 'A', top: 'S', right: 'P', bottom: 'I' });
  });
});

describe('PACS slice and window controls', () => {
  it('formats the slice and window overlays', () => {
    expect(formatSliceOverlay(160, 313, 12.34)).toBe('Im 161/313 · 12.3 mm');
    expect(formatWindowOverlay(200.4, 160.2)).toBe('WL 160 WW 200');
  });

  it('scrolls by whole slices and keeps the drag remainder', () => {
    expect(scrollIndex(0, -3, 10)).toBe(0);
    expect(scrollIndex(9, 4, 10)).toBe(9);
    expect(scrollIndex(4, 2, 10)).toBe(6);
    expect(consumeDragSteps(0, 20)).toEqual({ carried: 4, steps: 2 });
    expect(consumeDragSteps(0, -20)).toEqual({ carried: -4, steps: -2 });
  });

  it('maps a window drag and offers bone and soft-tissue presets', () => {
    expect(dragWindowLevel({ width: 100, level: 80 }, 40, -10)).toEqual({ width: 140, level: 90 });
    expect(dragWindowLevel({ width: 20, level: 4 }, -100, 40).width).toBe(8);
    expect(dragWindowLevel({ width: 20, level: 4 }, -100, 40).level).toBe(0);
    expect(WINDOW_PRESETS.bone.width).toBeGreaterThan(WINDOW_PRESETS.soft.width);
    expect(WINDOW_PRESETS.bone.level).toBeGreaterThan(WINDOW_PRESETS.soft.level);
  });

  it('letterboxes a slice inside the pane', () => {
    const rect = containedRect({ width: 200, height: 100 }, { width: 100, height: 100 });
    expect(rect).toEqual({ x: 50, y: 0, width: 100, height: 100 });
  });
});

describe('CT panel chrome', () => {
  it('names the OpenEar source in both languages', () => {
    const credit = 'OpenEar ZETA · Sieber et al., Sci Data 2018 · CC BY 4.0';
    expect(en['ct.credit']).toBe(credit);
    expect(ko['ct.credit']).toBe(credit);
  });

  it('keeps a slice slider on each pane and a tablet grid under the navigation', () => {
    const root = resolve(import.meta.dirname, '..');
    const page = readFileSync(resolve(root, 'src/temporal-bone/main.ts'), 'utf8');
    const css = readFileSync(resolve(root, 'src/styles/app.css'), 'utf8');
    expect(page.match(/class="pacs-slider"/g)?.length).toBe(3);
    expect(page).toContain('data-i18n="ct.credit"');
    expect(css).toContain('body.is-pacs.is-tablet .workspace { top: var(--topbar-h, 48px); }');
    expect(css).toContain('body.is-pacs.is-tablet-portrait .stage');
    expect(css).toContain('body.is-pacs.is-tablet-portrait[data-pacs-show="3d"] .pacs-bar { margin-top: auto; pointer-events: auto; }');
    expect(css).toContain('inset: 0 0 60px 0');
    expect(css).toContain('grid-row: 1 / span 3');
    expect(css).toContain('.pacs-slider {\n  position: absolute;');
    expect(css).toMatch(/\.pacs-slider \{[\s\S]*?height:\s*44px/);
  });
});

describe('published CT stacks', () => {
  it('has one slice image for every voxel along each file axis', () => {
    const root = resolve(import.meta.dirname, '../public/temporal-bone/ct');
    const volume = JSON.parse(readFileSync(resolve(root, 'volume.json'), 'utf8')) as VolumeMeta;
    expect(readdirSync(resolve(root, 'axial')).filter((name) => name.endsWith('.webp'))).toHaveLength(volume.dims[2]);
    expect(readdirSync(resolve(root, 'coronal')).filter((name) => name.endsWith('.webp'))).toHaveLength(volume.dims[1]);
    expect(readdirSync(resolve(root, 'sagittal')).filter((name) => name.endsWith('.webp'))).toHaveLength(volume.dims[0]);
    expect(volume.spacing_mm).toEqual([0.25, 0.25, 0.25]);
  });
});
