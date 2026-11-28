import { describe, expect, it } from 'vitest';
import { clampDragStep, MAX_DRAG_STEP_RAD, resumeDragPixels } from '../src/shared/orbit-guard';

describe('one-finger rotate after a pinch', () => {
  it('does not apply the distance the finger moved while a second finger froze tracking', () => {
    const tracked = { x: 180, y: 320 };
    const current = { x: 40, y: 460 };
    const stale = resumeDragPixels(tracked, current, false);
    expect(stale).toBeGreaterThan(160);
    expect(resumeDragPixels(tracked, current, true)).toBe(0);
  });

  it('clamps one frame of drag, including a spin that wrapped past half a turn', () => {
    expect(clampDragStep(1.2)).toBe(MAX_DRAG_STEP_RAD);
    expect(clampDragStep(-2)).toBe(-MAX_DRAG_STEP_RAD);
    expect(clampDragStep(0.2)).toBeCloseTo(0.2);
    expect(Math.abs(clampDragStep(Math.PI + 0.2))).toBeLessThanOrEqual(MAX_DRAG_STEP_RAD);
  });
});
