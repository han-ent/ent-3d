import { describe, expect, it } from 'vitest';
import { columnPlacements, englishFirst, focusPartList, labelAllowed, placeLabels, tiersForDistance, type StudyLabel } from '../src/shared/labels';

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

  it('dims an occluded label', () => {
    const placed = placeLabels(
      [{ id: 'hidden', priority: 5, anchorX: 30, anchorY: 30, width: 40, height: 18, occluded: true }],
      120,
      120,
    );
    expect(placed[0]?.dimmed).toBe(true);
  });
});
