import { voxelCenter } from './ct';
import { sliceFractions } from './ct-slice';
import { ctDisplayOrient, mapRawToDisplay, type StackPlane } from './frame';
import type { VolumeMeta } from './types';

/** Display presets for the published 0–255 slices. These are not Hounsfield windows. */
export const WINDOW_PRESETS = {
  bone: { width: 200, level: 160 },
  soft: { width: 90, level: 55 },
} as const;

export type WindowLevel = { width: number; level: number };

export function formatSliceOverlay(index: number, count: number, positionMm: number): string {
  return `Im ${index + 1}/${count} · ${positionMm.toFixed(1)} mm`;
}

export function formatWindowOverlay(width: number, level: number): string {
  return `WL ${Math.round(level)} WW ${Math.round(width)}`;
}

export function scrollIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, index + delta));
}

/** Carry leftover pixels so a slow drag still advances one slice at a time. */
export function consumeDragSteps(carried: number, dy: number, stepPx = 8): { carried: number; steps: number } {
  const next = carried + dy;
  const steps = Math.trunc(next / stepPx);
  return { carried: next - steps * stepPx, steps };
}

/** Horizontal drag widens the window. Dragging up raises the level. */
export function dragWindowLevel(start: WindowLevel, dx: number, dy: number): WindowLevel {
  return {
    width: Math.max(8, Math.min(400, Math.round(start.width + dx))),
    level: Math.max(0, Math.min(255, Math.round(start.level - dy))),
  };
}

export function containedRect(
  box: { width: number; height: number },
  image: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const scale = Math.min(box.width / Math.max(1, image.width), box.height / Math.max(1, image.height));
  const width = image.width * scale;
  const height = image.height * scale;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

/** Display fraction of a voxel center on the slice that contains it. */
export function displayOfVoxel(
  volume: VolumeMeta,
  folder: StackPlane,
  i: number,
  j: number,
  k: number,
): { u: number; v: number } {
  const point = voxelCenter(volume, i, j, k);
  const index = [i, j, k][volume.planes[folder].axis] ?? 0;
  const frac = sliceFractions(volume, folder, index, point);
  return mapRawToDisplay(ctDisplayOrient(folder), frac.col01, frac.row01);
}
