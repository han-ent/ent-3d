import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANATOMICAL_COLORS, STRUCTURE_COLOR } from '../src/shared/palette';
import type { Manifest } from '../src/shared/types';

describe('anatomical colours', () => {
  it('keeps every convention colour distinct', () => {
    const values = Object.values(ANATOMICAL_COLORS);
    expect(new Set(values).size).toBe(values.length);
    expect(ANATOMICAL_COLORS.artery).toBe('#C8322F');
    expect(ANATOMICAL_COLORS.vein).toBe('#2F5FA8');
    expect(ANATOMICAL_COLORS.dura).toBe('#B8B0A0');
    expect(ANATOMICAL_COLORS.facialNerve).toBe('#E3B629');
    expect(ANATOMICAL_COLORS.bone).toBe('#E8DFC8');
    expect(ANATOMICAL_COLORS.ossicle).toBe('#D6C49A');
    expect(ANATOMICAL_COLORS.softTissue).toBe('#D9B8B0');
    expect(ANATOMICAL_COLORS.scalaVestibuli).not.toBe(ANATOMICAL_COLORS.scalaTympani);
    expect(ANATOMICAL_COLORS.chorda).not.toBe(ANATOMICAL_COLORS.cochleovestibular);
    expect(ANATOMICAL_COLORS.chorda).not.toBe(ANATOMICAL_COLORS.facialNerve);
  });

  it('paints the manifest from that palette, sharing a colour only for the ossicles', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../public/temporal-bone/manifest.json'), 'utf8'),
    ) as Manifest;
    const byColor = new Map<string, string[]>();
    for (const structure of manifest.structures) {
      expect(structure.color).toBe(STRUCTURE_COLOR[structure.id]);
      const list = byColor.get(structure.color) ?? [];
      list.push(structure.id);
      byColor.set(structure.color, list);
    }
    for (const [color, ids] of byColor) {
      if (ids.length === 1) continue;
      expect(color).toBe(ANATOMICAL_COLORS.ossicle);
      expect(ids.sort()).toEqual(['incus', 'malleus', 'stapes']);
    }
  });
});
