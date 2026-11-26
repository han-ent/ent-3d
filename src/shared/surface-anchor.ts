import type { Vec3 } from './types';

/** Semicircular-canal labels use the arch landmark, which sits on the canal wall. */
export const CANAL_WALL: Record<string, string> = {
  'scc-lateral': 'scc-lateral-arch',
  'scc-superior': 'scc-superior-arch',
  'scc-posterior': 'scc-posterior-arch',
};

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function at(positions: ArrayLike<number>, index: number): Vec3 {
  return [positions[index * 3] ?? 0, positions[index * 3 + 1] ?? 0, positions[index * 3 + 2] ?? 0];
}

/** Distance along +X to the triangle, or null when the ray misses. */
function hitAlongX(origin: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const dir: Vec3 = [1, 0, 0];
  const ab = sub(b, a);
  const ac = sub(c, a);
  const pvec = cross(dir, ac);
  const det = dot(ab, pvec);
  if (Math.abs(det) < 1e-8) return null;
  const inv = 1 / det;
  const tvec = sub(origin, a);
  const u = dot(tvec, pvec) * inv;
  if (u < -1e-6 || u > 1 + 1e-6) return null;
  const qvec = cross(tvec, ab);
  const v = dot(dir, qvec) * inv;
  if (v < -1e-6 || u + v > 1 + 1e-6) return null;
  const t = dot(ac, qvec) * inv;
  return t > 1e-4 ? t : null;
}

/** Odd crossings of a +X ray mean the point is inside the mesh. */
export function pointInsideMesh(
  point: Vec3,
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null,
  triangleStride = 1,
): boolean {
  const triangles = index ? Math.floor(index.length / 3) : Math.floor(positions.length / 9);
  const step = Math.max(1, triangleStride);
  let hits = 0;
  for (let triangle = 0; triangle < triangles; triangle += step) {
    const read = (vertex: number): Vec3 => {
      const slot = index ? index[triangle * 3 + vertex]! : triangle * 3 + vertex;
      return at(positions, slot);
    };
    if (hitAlongX(point, read(0), read(1), read(2)) !== null) hits += 1;
  }
  return hits % 2 === 1;
}

export function nearestVertex(point: Vec3, positions: ArrayLike<number>, stride = 1): Vec3 | null {
  const count = Math.floor(positions.length / 3);
  const step = Math.max(1, stride);
  let best: Vec3 | null = null;
  let bestD = Infinity;
  for (let i = 0; i < count; i += step) {
    const vertex = at(positions, i);
    const d =
      (vertex[0] - point[0]) ** 2 + (vertex[1] - point[1]) ** 2 + (vertex[2] - point[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = vertex;
    }
  }
  return best;
}

/**
 * Keep a centroid that sits in the mesh. When it lies in a hole, use the
 * nearest surface vertex so the leader meets the wall.
 */
export function labelAnchorPoint(
  centroid: Vec3,
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null,
  triangleStride = 1,
): Vec3 {
  if (positions.length < 9) return centroid;
  if (pointInsideMesh(centroid, positions, index, triangleStride)) return centroid;
  return nearestVertex(centroid, positions, Math.max(1, triangleStride)) ?? centroid;
}

/** Arch landmark when this structure is a semicircular canal; otherwise the mesh anchor. */
export function structureLabelAnchor(
  id: string,
  centroid: Vec3,
  walls: Readonly<Record<string, Vec3>>,
  mesh?: { positions: ArrayLike<number>; index: ArrayLike<number> | null; triangleStride?: number },
): Vec3 {
  const wallId = CANAL_WALL[id];
  if (wallId && walls[wallId]) return walls[wallId]!;
  if (!mesh) return centroid;
  return labelAnchorPoint(centroid, mesh.positions, mesh.index, mesh.triangleStride ?? 1);
}
