/**
 * Writes tiny SAMPLE glb meshes and synthetic CT slices.
 * The published temporal-bone folder now holds real OpenEar ZETA assets.
 * This script refuses to overwrite them unless --replace-with-sample is passed.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

if (!process.argv.includes('--replace-with-sample')) {
  console.error('Refusing to overwrite the OpenEar ZETA assets. Pass --replace-with-sample to restore the tiny sample.');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const dataDir = resolve(root, 'public/temporal-bone');
const volume = JSON.parse(readFileSync(resolve(dataDir, 'ct/volume.json'), 'utf8'));

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => scale(a, 1 / (len(a) || 1));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function merge(parts) {
  const positions = [];
  const normals = [];
  const indices = [];
  let base = 0;
  for (const part of parts) {
    positions.push(...part.positions);
    normals.push(...part.normals);
    for (const index of part.indices) indices.push(index + base);
    base += part.positions.length / 3;
  }
  return { positions, normals, indices };
}

function tubeMesh(points, radius, seg = 8) {
  const frames = [];
  let prev = null;
  for (let i = 0; i < points.length; i += 1) {
    const tangent = norm(sub(points[Math.min(i + 1, points.length - 1)], points[Math.max(i - 1, 0)]));
    let normal;
    if (!prev) {
      const tmp = Math.abs(tangent[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      normal = norm(cross(tangent, tmp));
    } else {
      normal = sub(prev, scale(tangent, dot(prev, tangent)));
      normal = len(normal) < 1e-5 ? norm(cross(tangent, [1, 0, 0])) : norm(normal);
    }
    frames.push({ normal, bin: norm(cross(tangent, normal)) });
    prev = normal;
  }
  const positions = [];
  const normals = [];
  const indices = [];
  for (let i = 0; i < points.length; i += 1) {
    for (let s = 0; s < seg; s += 1) {
      const ang = (s / seg) * Math.PI * 2;
      const radial = norm(add(scale(frames[i].normal, Math.cos(ang)), scale(frames[i].bin, Math.sin(ang))));
      positions.push(...add(points[i], scale(radial, radius)));
      normals.push(...radial);
    }
  }
  for (let i = 0; i < points.length - 1; i += 1) {
    for (let s = 0; s < seg; s += 1) {
      const s2 = (s + 1) % seg;
      const a = i * seg + s;
      const b = i * seg + s2;
      const c = (i + 1) * seg + s;
      const d = (i + 1) * seg + s2;
      indices.push(a, c, b, b, c, d);
    }
  }
  return { positions, normals, indices };
}

function sphereMesh(center, radius, wSeg = 14, hSeg = 10) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (let y = 0; y <= hSeg; y += 1) {
    const theta = (y / hSeg) * Math.PI;
    for (let x = 0; x <= wSeg; x += 1) {
      const phi = (x / wSeg) * Math.PI * 2;
      const n = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
      normals.push(...n);
      positions.push(center[0] + n[0] * radius, center[1] + n[1] * radius, center[2] + n[2] * radius);
    }
  }
  const stride = wSeg + 1;
  for (let y = 0; y < hSeg; y += 1) {
    for (let x = 0; x < wSeg; x += 1) {
      const a = y * stride + x;
      const b = a + stride;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return { positions, normals, indices };
}

function basis(normal) {
  const n = norm(normal);
  const tmp = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(n, tmp));
  return { n, u, v: norm(cross(n, u)) };
}

function capMesh(origin, outward, radius, seg) {
  const { n, u, v } = basis(outward);
  const positions = [...origin];
  const normals = [...n];
  const indices = [];
  for (let s = 0; s < seg; s += 1) {
    const ang = (s / seg) * Math.PI * 2;
    positions.push(...add(origin, add(scale(u, Math.cos(ang) * radius), scale(v, Math.sin(ang) * radius))));
    normals.push(...n);
  }
  for (let s = 0; s < seg; s += 1) indices.push(0, 1 + s, 1 + ((s + 1) % seg));
  return { positions, normals, indices };
}

function cylinderMesh(a, b, radius, seg = 18) {
  return merge([
    tubeMesh([a, b], radius, seg),
    capMesh(a, sub(a, b), radius, seg),
    capMesh(b, sub(b, a), radius, seg),
  ]);
}

function annulus(origin, outward, rIn, rOut, seg) {
  const { n, u, v } = basis(outward);
  const positions = [];
  const normals = [];
  const indices = [];
  for (let s = 0; s < seg; s += 1) {
    const ang = (s / seg) * Math.PI * 2;
    const dir = add(scale(u, Math.cos(ang)), scale(v, Math.sin(ang)));
    positions.push(...add(origin, scale(dir, rIn)), ...add(origin, scale(dir, rOut)));
    normals.push(...n, ...n);
  }
  for (let s = 0; s < seg; s += 1) {
    const s2 = (s + 1) % seg;
    const a = s * 2;
    const b = a + 1;
    const c = s2 * 2;
    const d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { positions, normals, indices };
}

function hollowCylinderMesh(a, b, rIn, rOut, seg = 24) {
  return merge([
    tubeMesh([a, b], rOut, seg),
    tubeMesh([a, b], rIn, seg),
    annulus(a, sub(a, b), rIn, rOut, seg),
    annulus(b, sub(b, a), rIn, rOut, seg),
  ]);
}

function boxMesh(center, size) {
  const hx = size[0] / 2;
  const hy = size[1] / 2;
  const hz = size[2] / 2;
  const faces = [
    { n: [1, 0, 0], v: [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]] },
    { n: [-1, 0, 0], v: [[-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz]] },
    { n: [0, 1, 0], v: [[-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]] },
    { n: [0, -1, 0], v: [[-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz]] },
    { n: [0, 0, 1], v: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, 0, -1], v: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
  ];
  const positions = [];
  const normals = [];
  const indices = [];
  faces.forEach((face, faceIndex) => {
    for (const vertex of face.v) positions.push(center[0] + vertex[0], center[1] + vertex[1], center[2] + vertex[2]);
    for (let i = 0; i < 4; i += 1) normals.push(...face.n);
    const o = faceIndex * 4;
    indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  return { positions, normals, indices };
}

function arcPoints(center, axis, zero, radius, arc, count) {
  const u = norm(zero);
  const v = norm(cross(norm(axis), u));
  const points = [];
  for (let i = 0; i <= count; i += 1) {
    const ang = -arc / 2 + (i / count) * arc;
    points.push(add(center, add(scale(u, Math.cos(ang) * radius), scale(v, Math.sin(ang) * radius))));
  }
  return points;
}

function cochleaPoints() {
  const center = [-7.5, -0.2, 3.1];
  const turns = 2.1;
  const count = 36;
  const points = [];
  for (let i = 0; i <= count; i += 1) {
    const t = i / count;
    const ang = t * turns * Math.PI * 2;
    const radius = 3.1 * (1 - t) + 0.5;
    points.push([
      center[0] + Math.cos(ang) * radius,
      center[1] - 1.8 + t * 4.2,
      center[2] + Math.sin(ang) * radius,
    ]);
  }
  return points;
}

function capsuleMesh(a, b, radius) {
  return merge([tubeMesh([a, b], radius, 10), sphereMesh(a, radius, 10, 6), sphereMesh(b, radius, 10, 6)]);
}

function discEnds(center, normal, thickness) {
  const n = norm(normal);
  return [add(center, scale(n, -thickness / 2)), add(center, scale(n, thickness / 2))];
}

const lateralCanal = arcPoints([-5.2, 2.3, -0.5], [0, 1, 0], [1, 0, 0], 2.6, (300 * Math.PI) / 180, 18);
const superiorCanal = arcPoints([-6.2, 3.8, -0.3], [0, 0, 1], [0, 1, 0], 3.0, (270 * Math.PI) / 180, 18);
const posteriorCanal = arcPoints([-5.5, 2.6, -2.6], [1, 0, 0], [0, 1, 0], 2.9, (270 * Math.PI) / 180, 18);
const cochlea = cochleaPoints();
const facial = [
  [-5.6, 2.0, 1.4],
  [-4.4, 3.2, 0.2],
  [-3.4, 3.6, -1.4],
  [-2.2, 2.8, -2.8],
  [-1.2, 1.6, -3.6],
  [-0.7, -0.4, -3.8],
  [-0.4, -3.0, -3.9],
  [-0.2, -6.0, -3.7],
];
const chorda = [
  [-2.2, 2.6, -2.6],
  [-1.2, 2.2, -0.8],
  [-0.2, 1.8, 0.8],
  [0.6, 1.5, 2.2],
];
const tmEnds = discEnds([0, 0, 0], [1, 0, 0], 0.28);
const eacA = [1.4, 0.1, 0.1];
const eacB = [12.2, 0.5, 0.25];

function nearPolyline(point, points, radius) {
  for (let i = 0; i < points.length - 1; i += 1) {
    const ab = sub(points[i + 1], points[i]);
    const t = clamp(dot(sub(point, points[i]), ab) / (dot(ab, ab) || 1e-8), 0, 1);
    if (len(sub(point, add(points[i], scale(ab, t)))) <= radius) return true;
  }
  return false;
}

function insideCylinder(point, a, b, radius) {
  const ab = sub(b, a);
  const t = dot(sub(point, a), ab) / (dot(ab, ab) || 1e-8);
  if (t < 0 || t > 1) return false;
  return len(sub(point, add(a, scale(ab, t)))) <= radius;
}

function insideHollow(point, a, b, rIn, rOut) {
  const ab = sub(b, a);
  const t = dot(sub(point, a), ab) / (dot(ab, ab) || 1e-8);
  if (t < 0 || t > 1) return false;
  const radial = len(sub(point, add(a, scale(ab, t))));
  return radial >= rIn && radial <= rOut;
}

function insideBox(point, center, size) {
  return (
    Math.abs(point[0] - center[0]) <= size[0] / 2 &&
    Math.abs(point[1] - center[1]) <= size[1] / 2 &&
    Math.abs(point[2] - center[2]) <= size[2] / 2
  );
}

const structures = [
  {
    id: 'mastoid',
    color: [0.776, 0.71, 0.635],
    rgb: [198, 181, 162, 255],
    mesh: merge([
      boxMesh([2.2, -0.5, -11], [11, 13, 1.1]),
      boxMesh([8.2, -0.5, -6.2], [1.1, 13, 8]),
    ]),
    contains: (p) => insideBox(p, [2.2, -0.5, -11], [11, 13, 1.1]) || insideBox(p, [8.2, -0.5, -6.2], [1.1, 13, 8]),
  },
  {
    id: 'external_auditory_canal',
    color: [0.553, 0.604, 0.671],
    rgb: [141, 154, 171, 255],
    mesh: hollowCylinderMesh(eacA, eacB, 3.0, 3.75),
    contains: (p) => insideHollow(p, eacA, eacB, 3.0, 3.75),
  },
  {
    id: 'vestibule',
    color: [0.478, 0.416, 0.831],
    rgb: [122, 106, 212, 255],
    mesh: sphereMesh([-6.3, 1.2, -0.5], 1.9),
    contains: (p) => len(sub(p, [-6.3, 1.2, -0.5])) <= 1.9,
  },
  {
    id: 'cochlea',
    color: [0.298, 0.498, 0.878],
    rgb: [76, 127, 224, 255],
    mesh: tubeMesh(cochlea, 0.58, 8),
    contains: (p) => nearPolyline(p, cochlea, 0.58),
  },
  {
    id: 'posterior_semicircular_canal',
    color: [0.239, 0.557, 0.722],
    rgb: [61, 142, 184, 255],
    mesh: tubeMesh(posteriorCanal, 0.42, 8),
    contains: (p) => nearPolyline(p, posteriorCanal, 0.42),
  },
  {
    id: 'superior_semicircular_canal',
    color: [0.239, 0.561, 0.384],
    rgb: [61, 143, 98, 255],
    mesh: tubeMesh(superiorCanal, 0.42, 8),
    contains: (p) => nearPolyline(p, superiorCanal, 0.42),
  },
  {
    id: 'lateral_semicircular_canal',
    color: [0.184, 0.616, 0.588],
    rgb: [47, 157, 150, 255],
    mesh: tubeMesh(lateralCanal, 0.42, 8),
    contains: (p) => nearPolyline(p, lateralCanal, 0.42),
  },
  {
    id: 'facial_nerve',
    color: [0.886, 0.365, 0.525],
    rgb: [226, 93, 134, 255],
    mesh: merge([tubeMesh(facial, 0.52, 8), sphereMesh([-3.4, 3.6, -1.4], 0.72, 10, 8)]),
    contains: (p) => nearPolyline(p, facial, 0.52) || len(sub(p, [-3.4, 3.6, -1.4])) <= 0.72,
  },
  {
    id: 'tympanic_membrane',
    color: [0.906, 0.769, 0.69],
    rgb: [231, 196, 176, 255],
    mesh: cylinderMesh(tmEnds[0], tmEnds[1], 4.3, 28),
    contains: (p) => insideCylinder(p, tmEnds[0], tmEnds[1], 4.3),
  },
  {
    id: 'malleus',
    color: [0.878, 0.694, 0.353],
    rgb: [224, 177, 90, 255],
    mesh: merge([
      capsuleMesh([0.15, -2.3, 0.5], [-0.7, 3.0, -0.3], 0.42),
      sphereMesh([-1.0, 3.7, -0.9], 1.1, 12, 8),
      sphereMesh([0.7, 1.1, 0.15], 0.4, 8, 6),
    ]),
    contains: (p) =>
      nearPolyline(p, [[0.15, -2.3, 0.5], [-0.7, 3.0, -0.3]], 0.42) ||
      len(sub(p, [-1.0, 3.7, -0.9])) <= 1.1 ||
      len(sub(p, [0.7, 1.1, 0.15])) <= 0.4,
  },
  {
    id: 'incus',
    color: [0.831, 0.537, 0.29],
    rgb: [212, 137, 74, 255],
    mesh: merge([
      sphereMesh([-1.9, 3.4, -2.0], 1.0, 12, 8),
      capsuleMesh([-1.7, 2.7, -1.7], [-2.75, 1.15, -0.5], 0.34),
    ]),
    contains: (p) =>
      len(sub(p, [-1.9, 3.4, -2.0])) <= 1.0 || nearPolyline(p, [[-1.7, 2.7, -1.7], [-2.75, 1.15, -0.5]], 0.34),
  },
  {
    id: 'stapes',
    color: [0.769, 0.361, 0.275],
    rgb: [196, 92, 70, 255],
    mesh: merge([
      sphereMesh([-3.1, 1.15, -0.45], 0.32, 8, 6),
      capsuleMesh([-3.1, 1.15, -0.45], [-4.4, 1.55, -0.15], 0.16),
      capsuleMesh([-3.1, 1.15, -0.45], [-4.4, 0.55, -0.8], 0.16),
      boxMesh([-4.45, 1.05, -0.45], [0.28, 1.45, 1.05]),
    ]),
    contains: (p) =>
      len(sub(p, [-3.1, 1.15, -0.45])) <= 0.32 ||
      nearPolyline(p, [[-3.1, 1.15, -0.45], [-4.4, 1.55, -0.15]], 0.16) ||
      nearPolyline(p, [[-3.1, 1.15, -0.45], [-4.4, 0.55, -0.8]], 0.16) ||
      insideBox(p, [-4.45, 1.05, -0.45], [0.28, 1.45, 1.05]),
  },
  {
    id: 'chorda_tympani',
    color: [0.941, 0.639, 0.753],
    rgb: [240, 163, 192, 255],
    mesh: tubeMesh(chorda, 0.2, 8),
    contains: (p) => nearPolyline(p, chorda, 0.2),
  },
];

function writeGlb(file, mesh, color, name) {
  const idx = mesh.indices.length > 65535 ? new Uint32Array(mesh.indices) : new Uint16Array(mesh.indices);
  const pos = Float32Array.from(mesh.positions);
  const nor = Float32Array.from(mesh.normals);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k], pos[i + k]);
      max[k] = Math.max(max[k], pos[i + k]);
    }
  }
  const idxBytes = Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength);
  const posBytes = Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength);
  const norBytes = Buffer.from(nor.buffer, nor.byteOffset, nor.byteLength);
  const idxPad = (4 - (idxBytes.length % 4)) % 4;
  const bin = Buffer.concat([idxBytes, Buffer.alloc(idxPad), posBytes, norBytes]);
  const json = {
    asset: {
      version: '2.0',
      generator: 'ent-3d-placeholder',
      extras: { sample: true, label: 'SAMPLE placeholder — not OpenEar geometry' },
    },
    scene: 0,
    scenes: [{ nodes: [0], name: 'SAMPLE' }],
    nodes: [{ mesh: 0, name }],
    meshes: [{
      name,
      primitives: [{ attributes: { POSITION: 1, NORMAL: 2 }, indices: 0, material: 0 }],
    }],
    materials: [{
      name: 'sample-material',
      doubleSided: true,
      pbrMetallicRoughness: {
        baseColorFactor: [color[0], color[1], color[2], 1],
        metallicFactor: 0.02,
        roughnessFactor: 0.62,
      },
    }],
    accessors: [
      { bufferView: 0, componentType: idx instanceof Uint32Array ? 5125 : 5123, count: idx.length, type: 'SCALAR' },
      { bufferView: 1, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
      { bufferView: 2, componentType: 5126, count: nor.length / 3, type: 'VEC3' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: idxBytes.length, target: 34963 },
      { buffer: 0, byteOffset: idxBytes.length + idxPad, byteLength: posBytes.length, target: 34962 },
      { buffer: 0, byteOffset: idxBytes.length + idxPad + posBytes.length, byteLength: norBytes.length, target: 34962 },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  const jsonBuf = Buffer.from(JSON.stringify(json));
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = (4 - (bin.length % 4)) % 4;
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad)]);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonChunk.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(out, 20);
  const binHeader = 20 + jsonChunk.length;
  out.writeUInt32LE(binChunk.length, binHeader);
  out.writeUInt32LE(0x004e4942, binHeader + 4);
  binChunk.copy(out, binHeader + 8);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, out);
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function column(direction, axis) {
  return [direction[axis], direction[3 + axis], direction[6 + axis]];
}
function voxelCenter(i, j, k) {
  const ijk = [i, j, k];
  const point = [...volume.origin_mm];
  for (let axis = 0; axis < 3; axis += 1) {
    const direction = column(volume.direction, axis);
    const delta = ijk[axis] * volume.spacing_mm[axis];
    point[0] += direction[0] * delta;
    point[1] += direction[1] * delta;
    point[2] += direction[2] * delta;
  }
  return point;
}

const planeAxes = {
  axial: { normal: 1, u: 0, v: 2 },
  coronal: { normal: 2, u: 0, v: 1 },
  sagittal: { normal: 0, u: 2, v: 1 },
};

function writeSlices() {
  const size = 64;
  for (const [name, axes] of Object.entries(planeAxes)) {
    if (volume.planes[name].axis !== axes.normal) {
      throw new Error(`${name} axis must be ${axes.normal}`);
    }
    const count = volume.dims[axes.normal];
    const folder = resolve(dataDir, volume.planes[name].folder);
    mkdirSync(folder, { recursive: true });
    for (let index = 0; index < count; index += 1) {
      const rgba = Buffer.alloc(size * size * 4);
      for (let py = 0; py < size; py += 1) {
        for (let px = 0; px < size; px += 1) {
          const u = (px + 0.5) / size;
          const v = 1 - (py + 0.5) / size;
          const ijk = [
            (volume.dims[0] - 1) / 2,
            (volume.dims[1] - 1) / 2,
            (volume.dims[2] - 1) / 2,
          ];
          ijk[axes.normal] = index;
          ijk[axes.u] = -0.5 + u * volume.dims[axes.u];
          ijk[axes.v] = -0.5 + v * volume.dims[axes.v];
          const point = voxelCenter(ijk[0], ijk[1], ijk[2]);
          let rgb = [16 + index, 24, 34, 255];
          for (const structure of structures) {
            if (structure.contains(point)) rgb = structure.rgb;
          }
          if (px === 0 || py === 0 || px === size - 1 || py === size - 1) rgb = [186, 198, 208, 255];
          const offset = (py * size + px) * 4;
          rgba[offset] = rgb[0];
          rgba[offset + 1] = rgb[1];
          rgba[offset + 2] = rgb[2];
          rgba[offset + 3] = rgb[3];
        }
      }
      const dilated = Buffer.from(rgba);
      const isBg = (r, g, b) => r < 40 && g < 40 && b < 60;
      for (let py = 1; py < size - 1; py += 1) {
        for (let px = 1; px < size - 1; px += 1) {
          const offset = (py * size + px) * 4;
          if (!isBg(rgba[offset], rgba[offset + 1], rgba[offset + 2])) continue;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const n = ((py + dy) * size + (px + dx)) * 4;
            if (!isBg(rgba[n], rgba[n + 1], rgba[n + 2]) && rgba[n] !== 186) {
              dilated[offset] = rgba[n];
              dilated[offset + 1] = rgba[n + 1];
              dilated[offset + 2] = rgba[n + 2];
              dilated[offset + 3] = 255;
              break;
            }
          }
        }
      }
      const file = resolve(folder, `${String(index).padStart(2, '0')}.png`);
      writeFileSync(file, encodePng(size, size, dilated));
    }
    console.log(`${name}: ${count} slices`);
  }
}

function writeIcon(size, file) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - c;
      const dy = y - c;
      const d = Math.hypot(dx, dy);
      const inside = d < size * 0.36 && d > size * 0.22 && dx < size * 0.08;
      const bar = Math.abs(dy) < size * 0.05 && dx > -size * 0.05 && dx < size * 0.22;
      const rgb = inside || bar ? [255, 255, 255, 255] : [14, 63, 77, 255];
      const offset = (y * size + x) * 4;
      rgba[offset] = rgb[0];
      rgba[offset + 1] = rgb[1];
      rgba[offset + 2] = rgb[2];
      rgba[offset + 3] = rgb[3];
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, encodePng(size, size, rgba));
}

for (const structure of structures) {
  const file = resolve(dataDir, 'models', `${structure.id}.glb`);
  writeGlb(file, structure.mesh, structure.color, `SAMPLE ${structure.id}`);
  console.log(structure.id, structure.mesh.positions.length / 3, 'vertices');
}
writeSlices();
writeIcon(192, resolve(root, 'public/icons/icon-192.png'));
writeIcon(512, resolve(root, 'public/icons/icon-512.png'));
