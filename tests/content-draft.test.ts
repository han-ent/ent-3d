import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StructureContent } from '../src/shared/types';

const dir = resolve(import.meta.dirname, '../public/temporal-bone/content');

function read(id: string): StructureContent {
  return JSON.parse(readFileSync(resolve(dir, `${id}.json`), 'utf8')) as StructureContent;
}

describe('reviewed-draft copy', () => {
  it('keeps the malleus anatomy verbatim', () => {
    const malleus = read('malleus');
    expect(malleus.anatomy.ko.startsWith('머리(head)는 침골 몸체와 관절하여')).toBe(true);
    expect(malleus.anatomy.ko).toContain('Prussak 공간은 pars flaccida 바로 내측, 추골 머리·목의 외측에 위치함');
    expect(malleus.review).toBe('미검증');
    expect(malleus.sources[0]?.verified).toBe(true);
    expect(malleus.sources.every((source) => source.verified === true)).toBe(true);
  });

  it('keeps both facial-nerve dehiscence figures as written', () => {
    const facial = read('facial-nerve');
    const points = facial.surgical_points.map((point) => point.text.ko).join('\n');
    expect(facial.anatomy.ko).toContain('Cummings는 약 25%에서 골 결손');
    expect(points).toContain('Cummings 약 25%, Francis 약 16%');
    expect(points).toContain('약 20%');
    expect(points).toContain('55%');
    expect(facial.sources.every((source) => source.verified === true)).toBe(true);
  });

  it('keeps the chorda course without a processing note', () => {
    const chorda = read('chorda-tympani');
    const joined = chorda.surgical_points.map((point) => point.text.ko).join('\n');
    expect(joined).toContain('고막이 투명하면 고실 안에서 보일 수 있으므로');
    expect(joined).not.toContain('확인하지');
    expect(chorda.sources.some((source) => source.citation.includes('Cummings'))).toBe(true);
  });

  it('keeps the two scalae distinct and sourced', () => {
    const vestibuli = read('scala-vestibuli');
    const tympani = read('scala-tympani');
    expect(vestibuli.anatomy.ko).not.toBe(tympani.anatomy.ko);
    expect(tympani.anatomy.ko).toContain('정원창');
    expect(vestibuli.anatomy.en).toContain('vestibule');
    expect(vestibuli.sources[0]?.page.length).toBeGreaterThan(0);
    for (const id of ['bone', 'tympanic-membrane', 'external-auditory-canal', 'cochleovestibular-nerve']) {
      const content = read(id);
      expect(content.anatomy.ko).not.toContain('[샘플]');
      expect(content.anatomy.en.length).toBeGreaterThan(20);
      expect(content.sources[0]?.citation.length).toBeGreaterThan(0);
    }
    const carotid = read('carotid-artery');
    expect(carotid.anatomy.ko).toContain('경정맥구(jugular bulb)');
    expect(carotid.function.ko).not.toContain('확인하지');
    expect(carotid.sources.some((source) => source.citation.includes('Cummings'))).toBe(true);
    const sinus = read('sinus-dura');
    expect(sinus.anatomy.ko.startsWith('추체부 후면은 구불정맥동')).toBe(true);
  });
});
