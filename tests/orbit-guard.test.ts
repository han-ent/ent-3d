import { describe, expect, it } from 'vitest';
import { clampDragStep, easeOrbitOffset, MAX_DRAG_STEP_RAD, MAX_HOLD_STEP_RAD, offsetAngle, resumeDragPixels } from '../src/shared/orbit-guard';

describe('one-finger rotate after a pinch', () => {
  it('does not apply the distance the finger moved while a second finger froze tracking', () => {
    const tracked = { x: 180, y: 320 };
    const current = { x: 40, y: 460 };
    const stale = resumeDragPixels(tracked, current, false);
    expect(stale).toBeGreaterThan(160);
    expect(resumeDragPixels(tracked, current, true)).toBe(0);
  });

  it('eases a close-range swing back toward the surface instead of snapping about 70 degrees', () => {
    const current: [number, number, number] = [0, 0.94, 0.34];
    const desired: [number, number, number] = [0, 0, 9.5];
    const full = offsetAngle(current, desired);
    expect(full * 180 / Math.PI).toBeGreaterThan(60);
    const step = easeOrbitOffset(current, desired, MAX_HOLD_STEP_RAD);
    const moved = offsetAngle(current, step);
    expect(moved).toBeLessThan((10 * Math.PI) / 180);
    expect(moved).toBeGreaterThan(0);
  });

  it('clamps one frame of drag, including a spin that wrapped past half a turn', () => {
    expect(clampDragStep(1.2)).toBe(MAX_DRAG_STEP_RAD);
    expect(clampDragStep(-2)).toBe(-MAX_DRAG_STEP_RAD);
    expect(clampDragStep(0.2)).toBeCloseTo(0.2);
    expect(Math.abs(clampDragStep(Math.PI + 0.2))).toBeLessThanOrEqual(MAX_DRAG_STEP_RAD);
  });
});
