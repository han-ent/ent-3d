import { describe, expect, it } from 'vitest';
import { chooseStudyLabels, columnPlacements, dedupeStudyLabels, englishFirst, focusPartList, labelAllowed, phoneLabelCap, placeLabels, relayoutOnTweenEnd, thinForPhone, tiersForDistance, touchLabelBox, usesPhoneLabelLayout, usesTouchLabelMetrics, type StudyLabel } from '../src/shared/labels';

const label = (patch: Partial<StudyLabel>): StudyLabel => ({
  id: 'malleus-umbo',
  text: 'Umbo',
  en: 'Umbo',
  ko: '제(umbo)',
  tier: 'subpart',
  modes: ['surgical', 'all'],
  priority: 10,
  parentId: 'malleus',
  position: [0, 0, 0],
  ...patch,
});

describe('english-first labels', () => {
  it('puts the English name before Korean', () => {
    expect(englishFirst('Malleus', '추골(망치뼈)')).toBe('Malleus 추골(망치뼈)');
    expect(englishFirst('Incus', '')).toBe('Incus');
  });

  it('changes tier with camera distance', () => {
    expect(tiersForDistance(80)).toEqual(['region', 'surface']);
    expect(tiersForDistance(40)).toEqual(['structure']);
    expect(tiersForDistance(12)).toEqual(['structure', 'subpart']);
  });

  it('lets the selected mode win over camera distance', () => {
    const item = label({});
    expect(labelAllowed(item, 'surgical', 12, 'malleus', 'bone')).toBe(true);
    expect(labelAllowed(item, 'surgical', 90, null, 'bone')).toBe(true);
    expect(labelAllowed(item, 'basic', 12, 'malleus', 'bone')).toBe(false);
    expect(labelAllowed(item, 'all', 90, null, 'bone')).toBe(true);
    expect(labelAllowed(item, 'basic', 12, null, 'bone')).toBe(false);
  });
});

describe('label collision', () => {
  it('keeps the higher priority label and turns the other into a dot', () => {
    const placed = placeLabels(
      [
        { id: 'a', priority: 10, anchorX: 40, anchorY: 40, width: 80, height: 18, occluded: false },
        { id: 'b', priority: 90, anchorX: 42, anchorY: 42, width: 80, height: 18, occluded: false },
      ],
      200,
      200,
    );
    const first = placed.find((item) => item.id === 'b');
    const second = placed.find((item) => item.id === 'a');
    expect(first?.mode).toBe('label');
    expect(second?.mode === 'dot' || second?.mode === 'label').toBe(true);
    if (first?.mode === 'label' && second?.mode === 'label') {
      const overlap =
        first.x < second.x + 80 && first.x + 80 > second.x && first.y < second.y + 18 && first.y + 18 > second.y;
      expect(overlap).toBe(false);
    }
  });

  it('stacks every selected malleus part without overlap', () => {
    expect(focusPartList('malleus')).toEqual([
      'malleus-head',
      'malleus-neck',
      'malleus-manubrium',
      'malleus-lateral-process',
      'malleus-anterior-process',
      'umbo',
    ]);
    expect(focusPartList('fn-mastoid')).toEqual(focusPartList('facial-nerve'));
    const placed = columnPlacements(
      ['Head', 'Neck', 'Manubrium', 'Lateral process', 'Anterior process', 'Umbo'].map((id, index) => ({
        id,
        anchorX: 400,
        anchorY: 280 + index * 14,
        width: 140,
        height: 34,
      })),
      1280,
      800,
      { top: 58, right: 16, bottom: 108, left: 16 },
    );
    expect(placed).toHaveLength(6);
    expect(placed.every((item) => item.mode === 'label' && !item.dimmed)).toBe(true);
    expect(placed.map((item) => item.id)).toEqual(['Head', 'Neck', 'Manubrium', 'Lateral process', 'Anterior process', 'Umbo']);
    for (let index = 1; index < placed.length; index += 1) {
      const previous = placed[index - 1]!;
      const current = placed[index]!;
      expect(current.y).toBeGreaterThanOrEqual(previous.y + 34);
    }
  });

  it('keeps desktop label layout on a 1280px window', () => {
    expect(usesPhoneLabelLayout(1280)).toBe(false);
    expect(usesPhoneLabelLayout(959)).toBe(true);
    expect(usesPhoneLabelLayout(390)).toBe(true);
    expect(usesTouchLabelMetrics(1280, 800, false)).toBe(false);
    expect(usesTouchLabelMetrics(1180, 820, true)).toBe(true);
    expect(usesTouchLabelMetrics(820, 1180, true)).toBe(true);
  });

  it('does not overlap inner-ear pills on an iPad', () => {
    const names = ['Superior SCC', 'IAC', 'Cochlea', 'Vestibule', 'Lateral SCC', 'Posterior SCC', 'Facial nerve'];
    const overlaps = (
      a: { x: number; y: number; w: number; h: number },
      b: { x: number; y: number; w: number; h: number },
    ) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    for (const [width, height] of [
      [1180, 820],
      [820, 1180],
    ] as const) {
      const items = names.map((text, index) => {
        const box = touchLabelBox(text, true);
        return {
          id: text,
          anchorX: width * 0.46,
          anchorY: 140 + index * 36,
          width: box.width,
          height: box.height,
          priority: 90 - index,
        };
      });
      const sheet = Math.min(width * 0.32, 320);
      const placed = columnPlacements(items, width, height, {
        top: 72,
        right: sheet + 16,
        bottom: 28,
        left: 12,
      });
      expect(placed.length).toBeGreaterThan(3);
      for (let i = 0; i < placed.length; i += 1) {
        for (let j = i + 1; j < placed.length; j += 1) {
          const left = placed[i]!;
          const right = placed[j]!;
          const leftBox = items.find((item) => item.id === left.id)!;
          const rightBox = items.find((item) => item.id === right.id)!;
          expect(
            overlaps(
              { x: left.x, y: left.y, w: leftBox.width, h: leftBox.height },
              { x: right.x, y: right.y, w: rightBox.width, h: rightBox.height },
            ),
          ).toBe(false);
        }
      }
    }
  });

  it('keeps the selected name on a phone and thins the rest when far', () => {
    const labels = [
      { id: 'bone', priority: 80 },
      { id: 'cochlea', priority: 70 },
      { id: 'vestibule', priority: 60 },
      { id: 'tm-pars-flaccida', priority: 64 },
      { id: 'stapes', priority: 40 },
      { id: 'incus', priority: 30 },
      { id: 'malleus', priority: 20 },
    ];
    expect(phoneLabelCap(800)).toBe(4);
    expect(phoneLabelCap(200)).toBe(6);
    const far = thinForPhone(labels, 800, 'stapes');
    expect(far.map((item) => item.id)).toContain('stapes');
    expect(far).toHaveLength(4);
    const placed = placeLabels(
      far.map((item, index) => ({
        id: item.id,
        priority: item.priority,
        anchorX: 40 + index * 12,
        anchorY: 80,
        width: 100,
        height: 48,
        occluded: false,
      })),
      375,
      667,
      { top: 68, right: 78, bottom: 260, left: 12 },
    );
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i]!;
        const b = placed[j]!;
        if (a.mode !== 'label' || b.mode !== 'label') continue;
        const overlap = a.x < b.x + 100 && a.x + 100 > b.x && a.y < b.y + 48 && a.y + 48 > b.y;
        expect(overlap).toBe(false);
      }
    }
  });

  it('keeps a column beside the anchors and drops what does not fit', () => {
    const placed = columnPlacements(
      [
        { id: 'low', anchorX: 180, anchorY: 200, width: 90, height: 30, priority: 1 },
        { id: 'mid', anchorX: 180, anchorY: 160, width: 90, height: 30, priority: 5 },
        { id: 'high', anchorX: 180, anchorY: 120, width: 90, height: 30, priority: 9 },
      ],
      390,
      220,
      { top: 40, right: 20, bottom: 80, left: 12 },
    );
    expect(placed.map((item) => item.id)).toEqual(['high', 'mid']);
    for (const item of placed) {
      expect(item.y).toBeGreaterThanOrEqual(40);
      expect(item.y + 30).toBeLessThanOrEqual(220 - 80 + 1);
      expect(item.x + 90 <= 180 - 8 || item.x >= 180 + 8).toBe(true);
    }
  });

  it('keeps one Lateral SCC and prefers the arch-anchored structure', () => {
    const structure = (id: string, en: string, ko: string, position: [number, number, number]): StudyLabel => ({
      id,
      text: en,
      en,
      ko,
      tier: 'structure',
      modes: ['basic', 'surgical', 'all'],
      priority: 86,
      position,
      stages: ['inner'],
    });
    const landmark = (id: string, en: string, ko: string, parentId: string, position: [number, number, number]): StudyLabel => ({
      id,
      text: en,
      en,
      ko,
      tier: 'subpart',
      modes: ['surgical', 'all'],
      priority: 72,
      parentId,
      position,
      stages: ['inner'],
    });
    const arch: [number, number, number] = [24.6, 29.3, 52.6];
    const labels = dedupeStudyLabels([
      structure('scc-lateral', 'Lateral SCC', '외측반고리관', arch),
      landmark('scc-lateral-arch', 'Lateral SCC', '외측반고리관', 'scc-lateral', [24.6, 29.3, 52.6]),
      structure('scc-superior', 'Superior SCC', '상반고리관', [25, 22, 58]),
      landmark('scc-superior-arch', 'Superior SCC', '상반고리관', 'scc-superior', [25, 22, 58]),
      structure('scc-posterior', 'Posterior SCC', '후반고리관', [26, 34, 58]),
      landmark('scc-posterior-arch', 'Posterior SCC', '후반고리관', 'scc-posterior', [26, 34, 58]),
      structure('vestibule', 'Vestibule', '전정', [29, 31, 58]),
      landmark('vestibule-center', 'Vestibule', '전정', 'vestibule', [29, 31, 58]),
      structure('common-crus', 'Common crus', '총각', [27, 28, 60]),
      landmark('common-crus', 'Common crus', '총각', 'common-crus', [27, 28, 60]),
    ]);
    for (const mode of ['basic', 'surgical', 'all'] as const) {
      const shown = chooseStudyLabels(labels, mode, 80, null, 'inner', null);
      const names = shown.map((item) => item.en);
      expect(new Set(names).size, mode).toBe(names.length);
    }
    const lateral = labels.find((item) => item.en === 'Lateral SCC');
    expect(labels.filter((item) => item.en === 'Lateral SCC')).toHaveLength(1);
    expect(lateral?.id).toBe('scc-lateral');
    expect(lateral?.position).toEqual(arch);
    expect(lateral?.modes).toEqual(expect.arrayContaining(['basic', 'surgical', 'all']));
  });

  it('lays labels out again when a camera flight ends', () => {
    expect(relayoutOnTweenEnd(true, false)).toBe(true);
    expect(relayoutOnTweenEnd(true, true)).toBe(false);
    expect(relayoutOnTweenEnd(false, false)).toBe(false);
  });

  it('dims an occluded label', () => {
    const placed = placeLabels(
      [{ id: 'hidden', priority: 5, anchorX: 30, anchorY: 30, width: 40, height: 18, occluded: true }],
      120,
      120,
    );
    expect(placed[0]?.dimmed).toBe(true);
  });
});
