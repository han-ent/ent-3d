import { describe, expect, it } from 'vitest';
import { chooseScaleMm, distanceMm, formatMm, translate, worldClippingPlane } from '../src/shared/measurement';

describe('millimetre measurement', () => {
  it('returns Euclidean distance in millimetres', () => {
    expect(distanceMm([0, 0, 0], [3, 4, 0])).toBe(5);
    expect(distanceMm({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 6 })).toBe(3);
  });

  it('does not change when both points are translated by the viewer offset', () => {
    const offset: [number, number, number] = [120, -40, 15];
    const a = { x: 2, y: -3, z: 4 };
    const b = { x: 5, y: 1, z: -2 };
    expect(distanceMm(translate(a, offset), translate(b, offset))).toBeCloseTo(distanceMm(a, b));
  });

  it('formats short distances with two decimals', () => {
    expect(formatMm(4.256)).toBe('4.26 mm');
    expect(formatMm(12.24)).toBe('12.2 mm');
  });

  it('picks a scale-bar length that fits the target pixel width', () => {
    expect(chooseScaleMm(10, 96)).toEqual({ mm: 10, px: 100 });
    expect(chooseScaleMm(4, 96).mm).toBe(20);
    expect(chooseScaleMm(0)).toEqual({ mm: 10, px: 0 });
  });

  it('moves a clipping plane into world space with the viewer offset', () => {
    expect(worldClippingPlane([-1, 0, 0], 12, [0, 0, 0])).toEqual({ normal: [-1, 0, 0], constant: 12 });
    const moved = worldClippingPlane([-1, 0, 0], 12, [10, 0, 0]);
    expect(moved.constant).toBe(22);
    const worldX = 12 + 10;
    expect(moved.normal[0] * worldX + moved.constant).toBeCloseTo(0);
  });
});
