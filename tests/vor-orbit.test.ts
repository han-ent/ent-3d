import { describe, expect, it } from 'vitest';
import { MAX_HOLD_STEP_RAD } from '../src/shared/orbit-guard';
import { baselineAfterPinch, dragAngle, zoomRadius } from '../src/vor/orbit';

describe('VOR camera drag', () => {
  it('caps one frame at the shared 6° step, including a long swipe', () => {
    expect(Math.abs(dragAngle(400))).toBeLessThanOrEqual(MAX_HOLD_STEP_RAD + 1e-9);
    expect(Math.abs(dragAngle(-400))).toBeLessThanOrEqual(MAX_HOLD_STEP_RAD + 1e-9);
    expect(dragAngle(2)).toBeCloseTo(0.02);
    expect(MAX_HOLD_STEP_RAD).toBeCloseTo((6 * Math.PI) / 180);
  });

  it('drops the motion that happened while a second finger was down', () => {
    const tracked = { x: 20, y: 40 };
    const current = { x: 220, y: 180 };
    const next = baselineAfterPinch(tracked, current);
    expect(next.jump).toBe(0);
    expect(next.point).toEqual(current);
  });

  it('refuses a pinch frame that would more than double the zoom step', () => {
    expect(zoomRadius(200, 0.2)).toBeGreaterThan(200 * 0.8);
    expect(zoomRadius(200, 4)).toBeLessThan(200 * 1.2);
  });
});
