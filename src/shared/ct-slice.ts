import { directionColumn, slicePose } from './ct';
import type { Vec3, VolumeMeta } from './types';

export type SliceName = 'axial' | 'coronal' | 'sagittal';

/** Display window on an already-published 0–255 slice. This is not a Hounsfield window. */
export function applyWindowLevel(value: number, width: number, level: number): number {
  const span = Math.max(1, width);
  const low = level - span / 2;
  const t = (value - low) / span;
  if (t <= 0) return 0;
  if (t >= 1) return 255;
  return Math.round(t * 255);
}

export function remapGray(pixels: Uint8ClampedArray, width: number, level: number, out: Uint8ClampedArray): void {
  for (let i = 0; i < pixels.length; i += 4) {
    const next = applyWindowLevel(pixels[i] ?? 0, width, level);
    out[i] = next;
    out[i + 1] = next;
    out[i + 2] = next;
    out[i + 3] = 255;
  }
}

/** Nearest slice index along one volume axis for a specimen-space point. */
export function indexAlong(volume: VolumeMeta, axis: 0 | 1 | 2, point: Vec3): number {
  const direction = directionColumn(volume.direction, axis);
  const relative: Vec3 = [
    point[0] - volume.origin_mm[0],
    point[1] - volume.origin_mm[1],
    point[2] - volume.origin_mm[2],
  ];
  const lengthSq = direction[0] * direction[0] + direction[1] * direction[1] + direction[2] * direction[2] || 1;
  const along = (relative[0] * direction[0] + relative[1] * direction[1] + relative[2] * direction[2]) / lengthSq;
  return Math.round(along / volume.spacing_mm[axis]);
}

/**
 * Specimen point for a pixel on the published slice.
 * `col01`/`row01` are 0–1 across the image. Row 0 is the top of the image,
 * which is the high end of the row axis when `row_0_is_max` is set.
 */
export function pointOnSlice(
  volume: VolumeMeta,
  plane: SliceName,
  index: number,
  col01: number,
  row01: number,
): Vec3 {
  const pose = slicePose(volume, plane, index);
  const def = volume.planes[plane];
  const rowDir = directionColumn(volume.direction, def.row_axis);
  const rowSign = def.row_0_is_max ? 1 : -1;
  const point: Vec3 = [pose.position[0], pose.position[1], pose.position[2]];
  for (let axis = 0; axis < 3; axis += 1) {
    point[axis] += pose.u[axis] * (col01 - 0.5) * pose.width;
    point[axis] += rowDir[axis] * rowSign * (0.5 - row01) * pose.height;
  }
  return point;
}

/** Pixel, in image fractions, of a specimen point on this slice. */
export function sliceFractions(
  volume: VolumeMeta,
  plane: SliceName,
  index: number,
  point: Vec3,
): { col01: number; row01: number } {
  const pose = slicePose(volume, plane, index);
  const def = volume.planes[plane];
  const rowDir = directionColumn(volume.direction, def.row_axis);
  const rowSign = def.row_0_is_max ? 1 : -1;
  const delta: Vec3 = [point[0] - pose.position[0], point[1] - pose.position[1], point[2] - pose.position[2]];
  const col = (delta[0] * pose.u[0] + delta[1] * pose.u[1] + delta[2] * pose.u[2]) / (pose.width || 1);
  const row = (delta[0] * rowDir[0] + delta[1] * rowDir[1] + delta[2] * rowDir[2]) / (pose.height || 1);
  return { col01: col + 0.5, row01: 0.5 - rowSign * row };
}

/** Move the crosshair onto a slice, keeping the in-plane position. */
export function movePointToSlice(volume: VolumeMeta, plane: SliceName, index: number, point: Vec3): Vec3 {
  const pose = slicePose(volume, plane, index);
  const axis = volume.planes[plane].axis;
  const next: Vec3 = [point[0], point[1], point[2]];
  next[axis] = pose.position[axis];
  return next;
}

export function segmentOnPlane(a: Vec3, b: Vec3, c: Vec3, origin: Vec3, normal: Vec3): [Vec3, Vec3] | null {
  const signed = (point: Vec3) =>
    (point[0] - origin[0]) * normal[0] + (point[1] - origin[1]) * normal[1] + (point[2] - origin[2]) * normal[2];
  const da = signed(a);
  const db = signed(b);
  const dc = signed(c);
  if ((da > 0 && db > 0 && dc > 0) || (da < 0 && db < 0 && dc < 0)) return null;
  const hits: Vec3[] = [];
  const edge = (p: Vec3, q: Vec3, dp: number, dq: number) => {
    if (dp === 0) hits.push(p);
    else if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) {
      const t = dp / (dp - dq);
      hits.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]);
    }
  };
  edge(a, b, da, db);
  edge(b, c, db, dc);
  edge(c, a, dc, da);
  if (hits.length < 2) return null;
  return [hits[0]!, hits[1]!];
}

export type ContourSource = {
  id: string;
  color: string;
  positions: ArrayLike<number>;
  index: ArrayLike<number> | null;
  /** Skip this many triangles. Heavy meshes can use 2. */
  stride?: number;
};

export type ContourSegment = { id: string; color: string; a: Vec3; b: Vec3 };

/** Intersect triangle meshes with a slice. `stride` skips triangles on heavy meshes. */
export function contoursOnPlane(
  sources: readonly ContourSource[],
  origin: Vec3,
  normal: Vec3,
  stride = 1,
): ContourSegment[] {
  const segments: ContourSegment[] = [];
  for (const source of sources) {
    const position = source.positions;
    const index = source.index;
    const step = Math.max(1, source.stride ?? stride);
    const triangleCount = index ? Math.floor(index.length / 3) : Math.floor(position.length / 9);
    for (let triangle = 0; triangle < triangleCount; triangle += step) {
      const read = (vertex: number): Vec3 => {
        const slot = index ? index[triangle * 3 + vertex]! : triangle * 3 + vertex;
        return [position[slot * 3]!, position[slot * 3 + 1]!, position[slot * 3 + 2]!];
      };
      const segment = segmentOnPlane(read(0), read(1), read(2), origin, normal);
      if (segment) segments.push({ id: source.id, color: source.color, a: segment[0], b: segment[1] });
    }
  }
  return segments;
}
