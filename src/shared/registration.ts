import type { Vec3 } from './types';

export type Mat3 = [Vec3, Vec3, Vec3];

export type Similarity = {
  scale: number;
  rotation: Mat3;
  translation: Vec3;
  residualsMm: number[];
  rmsMm: number;
};

export type DimensionCheck = {
  id: string;
  valueMm: number;
  meanMm: number;
  sdMm: number;
  z: number;
  flagged: boolean;
};

const Z_FLAG = 2.5;

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function mul(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function matMul(a: Mat3, b: Mat3): Mat3 {
  const cols = [0, 1, 2].map((j) => mul(a, [b[0][j], b[1][j], b[2][j]] as Vec3));
  return [
    [cols[0][0], cols[1][0], cols[2][0]],
    [cols[0][1], cols[1][1], cols[2][1]],
    [cols[0][2], cols[1][2], cols[2][2]],
  ];
}

function transpose(m: Mat3): Mat3 {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

export function det3(m: Mat3): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

function mean(points: Vec3[]): Vec3 {
  const s: Vec3 = [0, 0, 0];
  for (const p of points) {
    s[0] += p[0];
    s[1] += p[1];
    s[2] += p[2];
  }
  const n = points.length || 1;
  return [s[0] / n, s[1] / n, s[2] / n];
}

/** Eigenvectors of a symmetric 3×3, as columns. The matrix diagonal becomes the eigenvalues. */
function jacobiEigen(matrix: Mat3): Mat3 {
  const a: Mat3 = [
    [matrix[0][0], matrix[0][1], matrix[0][2]],
    [matrix[1][0], matrix[1][1], matrix[1][2]],
    [matrix[2][0], matrix[2][1], matrix[2][2]],
  ];
  const v: Mat3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 14; sweep += 1) {
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = a[p][q];
      if (Math.abs(apq) < 1e-15) continue;
      const app = a[p][p];
      const aqq = a[q][q];
      const tau = (aqq - app) / (2 * apq);
      const t = Math.sign(tau || 1) / (Math.abs(tau) + Math.hypot(1, tau));
      const c = 1 / Math.hypot(1, t);
      const s = t * c;
      a[p][p] = app - t * apq;
      a[q][q] = aqq + t * apq;
      a[p][q] = 0;
      a[q][p] = 0;
      for (let k = 0; k < 3; k += 1) {
        if (k === p || k === q) continue;
        const aik = a[k][p];
        const aiq = a[k][q];
        a[k][p] = c * aik - s * aiq;
        a[p][k] = a[k][p];
        a[k][q] = s * aik + c * aiq;
        a[q][k] = a[k][q];
      }
      for (let k = 0; k < 3; k += 1) {
        const vip = v[k][p];
        const viq = v[k][q];
        v[k][p] = c * vip - s * viq;
        v[k][q] = s * vip + c * viq;
      }
    }
  }
  matrix[0] = [a[0][0], a[0][1], a[0][2]];
  matrix[1] = [a[1][0], a[1][1], a[1][2]];
  matrix[2] = [a[2][0], a[2][1], a[2][2]];
  return v;
}

function column(m: Mat3, j: number): Vec3 {
  return [m[0][j], m[1][j], m[2][j]];
}

function fromColumns(cols: Vec3[]): Mat3 {
  return [
    [cols[0][0], cols[1][0], cols[2][0]],
    [cols[0][1], cols[1][1], cols[2][1]],
    [cols[0][2], cols[1][2], cols[2][2]],
  ];
}

function svd3(m: Mat3): { u: Mat3; s: Vec3; v: Mat3 } {
  const ata = matMul(transpose(m), m);
  const eigenvectors = jacobiEigen(ata);
  const ev: Vec3 = [ata[0][0], ata[1][1], ata[2][2]];
  const order = [0, 1, 2].sort((i, j) => ev[j] - ev[i]);
  const s = order.map((i) => Math.sqrt(Math.max(0, ev[i]))) as Vec3;
  const vCols = order.map((i) => column(eigenvectors, i));
  const v = fromColumns(vCols);
  const mv = matMul(m, v);
  const uCols: Vec3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let j = 0; j < 3; j += 1) {
    if (s[j] > 1e-10) uCols[j] = column(mv, j).map((value) => value / s[j]) as Vec3;
  }
  if (s[2] <= 1e-10) uCols[2] = cross(uCols[0], uCols[1]);
  if (s[1] <= 1e-10) uCols[1] = cross(uCols[2], uCols[0]);
  return { u: fromColumns(uCols), s, v };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function diagMul(s: Vec3, m: Mat3): Mat3 {
  return [
    [s[0] * m[0][0], s[0] * m[0][1], s[0] * m[0][2]],
    [s[1] * m[1][0], s[1] * m[1][1], s[1] * m[1][2]],
    [s[2] * m[2][0], s[2] * m[2][1], s[2] * m[2][2]],
  ];
}

/**
 * Umeyama similarity mapping `source` onto `target`.
 * Rotation is a proper rotation (det +1). Scale is free and positive when the
 * point sets are not mirror images.
 */
export function umeyama(source: Vec3[], target: Vec3[]): Similarity {
  if (source.length !== target.length || source.length < 3) {
    throw new Error('umeyama needs at least three paired points');
  }
  const n = source.length;
  const cs = mean(source);
  const ct = mean(target);
  let variance = 0;
  const cov: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < n; i += 1) {
    const x = sub(source[i], cs);
    const y = sub(target[i], ct);
    variance += x[0] * x[0] + x[1] * x[1] + x[2] * x[2];
    for (let r = 0; r < 3; r += 1) {
      cov[r][0] += y[r] * x[0];
      cov[r][1] += y[r] * x[1];
      cov[r][2] += y[r] * x[2];
    }
  }
  variance /= n;
  for (let r = 0; r < 3; r += 1) {
    cov[r][0] /= n;
    cov[r][1] /= n;
    cov[r][2] /= n;
  }
  const { u, s, v } = svd3(cov);
  const proper = det3(u) * det3(v) < 0 ? -1 : 1;
  const d: Vec3 = [1, 1, proper];
  const rotation = matMul(u, diagMul(d, transpose(v)));
  const scale = variance > 1e-12 ? (s[0] * d[0] + s[1] * d[1] + s[2] * d[2]) / variance : 1;
  const translation = sub(ct, mul(rotation, cs).map((value) => value * scale) as Vec3);
  const residualsMm = source.map((point, index) => {
    const moved = add(mul(rotation, point).map((value) => value * scale) as Vec3, translation);
    return Math.hypot(moved[0] - target[index][0], moved[1] - target[index][1], moved[2] - target[index][2]);
  });
  const rmsMm = Math.sqrt(residualsMm.reduce((sum, value) => sum + value * value, 0) / n);
  return { scale, rotation, translation, residualsMm, rmsMm };
}

export function pairDistances(source: Vec3[], target: Vec3[]): number[] {
  return source.map((point, index) =>
    Math.hypot(point[0] - target[index][0], point[1] - target[index][1], point[2] - target[index][2]),
  );
}

export function rms(values: number[]): number {
  if (!values.length) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
}

/** Flag a measurement that sits more than 2.5 SD from the published mean. */
export function checkDimension(id: string, valueMm: number, meanMm: number, sdMm: number): DimensionCheck {
  const z = sdMm > 0 ? (valueMm - meanMm) / sdMm : 0;
  return { id, valueMm, meanMm, sdMm, z, flagged: Math.abs(z) > Z_FLAG };
}
