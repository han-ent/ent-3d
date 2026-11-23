/**
 * Build the entry skin from the CC0 MakeHuman hm08 base mesh.
 * Keeps only the `body` group (helper hair, eyes, teeth, tongue, tights,
 * skirt, and joint cubes are dropped), crops to the head, neck, and shoulders,
 * flattens the base-mesh ears so the Z-Anatomy auricle is the ear, and plugs
 * the orbits with simple spheres.
 *
 * Expects /tmp/ent3d/base.obj. Run: node scripts/build_skin.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readBin(file) {
  const buf = fs.readFileSync(file);
  const vertexCount = buf.readUInt32LE(0);
  const positions = new Float32Array(buf.buffer, buf.byteOffset + 8, vertexCount * 3);
  const pts = [];
  for (let i = 0; i < vertexCount; i += 1) pts.push([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
  return pts;
}

function solve4(matrix, vector) {
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let col = 0; col < 4; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 4; row += 1) if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    if (Math.abs(rows[pivot][col]) < 1e-12) throw new Error('singular fit');
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const div = rows[col][col];
    for (let k = col; k < 5; k += 1) rows[col][k] /= div;
    for (let row = 0; row < 4; row += 1) {
      if (row === col) continue;
      const factor = rows[row][col];
      for (let k = col; k < 5; k += 1) rows[row][k] -= factor * rows[col][k];
    }
  }
  return rows.map((row) => row[4]);
}

function fitTranslation(pairs) {
  const normal = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const rhs = [0, 0, 0, 0];
  for (const pair of pairs) {
    for (let axis = 0; axis < 3; axis += 1) {
      const row = [pair.pre[axis], axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0];
      for (let i = 0; i < 4; i += 1) {
        rhs[i] += pair.w * row[i] * pair.target[axis];
        for (let j = 0; j < 4; j += 1) normal[i][j] += pair.w * row[i] * row[j];
      }
    }
  }
  const [scale, tx, ty, tz] = solve4(normal, rhs);
  return { scale, translation: [tx, ty, tz] };
}

function premultiply(point) {
  return [point[2] * 100, -point[1] * 100, point[0] * 100];
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function extreme(list, score) {
  let best = list[0];
  let bestScore = score(best);
  for (const point of list) {
    const value = score(point);
    if (value > bestScore) {
      bestScore = value;
      best = point;
    }
  }
  return best;
}

function parseObj(text) {
  const verts = [];
  const groups = new Map();
  let group = 'default';
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) {
      verts.push(line.trim().split(/\s+/).slice(1, 4).map(Number));
    } else if (line.startsWith('g ')) {
      group = line.slice(2).trim();
    } else if (line.startsWith('f ')) {
      const corners = line
        .trim()
        .split(/\s+/)
        .slice(1)
        .map((token) => Number(token.split('/')[0]) - 1);
      const list = groups.get(group) ?? [];
      if (corners.length === 3) list.push(corners);
      else if (corners.length === 4) list.push([corners[0], corners[1], corners[2]], [corners[0], corners[2], corners[3]]);
      groups.set(group, list);
    }
  }
  return { verts, groups };
}

function groupCentroid(verts, faces) {
  const seen = new Set();
  const sum = [0, 0, 0];
  let count = 0;
  for (const face of faces) {
    for (const index of face) {
      if (seen.has(index)) continue;
      seen.add(index);
      sum[0] += verts[index][0];
      sum[1] += verts[index][1];
      sum[2] += verts[index][2];
      count += 1;
    }
  }
  return sum.map((value) => value / count);
}

function groupRadius(verts, faces, center) {
  let best = 0;
  for (const face of faces) {
    for (const index of face) best = Math.max(best, dist(verts[index], center));
  }
  return best;
}

function sphere(center, radius, segments, rings) {
  const verts = [];
  const faces = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const phi = (ring / rings) * Math.PI;
    for (let step = 0; step < segments; step += 1) {
      const theta = (step / segments) * Math.PI * 2;
      verts.push([
        center[0] + radius * Math.sin(phi) * Math.cos(theta),
        center[1] + radius * Math.cos(phi),
        center[2] + radius * Math.sin(phi) * Math.sin(theta),
      ]);
    }
  }
  const index = (ring, step) => ring * segments + (step % segments);
  for (let ring = 0; ring < rings; ring += 1) {
    for (let step = 0; step < segments; step += 1) {
      const a = index(ring, step);
      const b = index(ring + 1, step);
      const c = index(ring + 1, step + 1);
      const d = index(ring, step + 1);
      faces.push([a, d, b], [b, d, c]);
    }
  }
  return { verts, faces };
}

const { verts, groups } = parseObj(fs.readFileSync('/tmp/ent3d/base.obj', 'utf8'));
const bodyFaces = groups.get('body') ?? [];
if (!bodyFaces.length) throw new Error('body group missing');
const leftEye = groupCentroid(verts, groups.get('helper-l-eye') ?? []);
const rightEye = groupCentroid(verts, groups.get('helper-r-eye') ?? []);
const eyeRadiusDm = groupRadius(verts, groups.get('helper-r-eye') ?? [], rightEye);
console.log('groups kept: body only. helper faces dropped', [...groups.keys()].filter((name) => name !== 'body').length);
console.log('eye radius dm', eyeRadiusDm.toFixed(3));

function keepVertex(point) {
  if (point[1] < 4.75) return false;
  if (point[1] < 6.02 && Math.abs(point[0]) > 1.82) return false;
  return true;
}

const kept = new Int32Array(verts.length).fill(-1);
const source = [];
verts.forEach((point, index) => {
  if (!keepVertex(point)) return;
  kept[index] = source.length;
  source.push(point.slice());
});
const tris = [];
for (const face of bodyFaces) {
  const mapped = face.map((index) => kept[index]);
  if (mapped.some((index) => index < 0)) continue;
  tris.push(mapped);
}

let flattened = 0;
for (const point of source) {
  const pinna = point[1] > 6.05 && point[1] < 7.05 && point[2] < 0.55 && point[2] > -0.4 && Math.abs(point[0]) > 0.9;
  if (!pinna) continue;
  const sign = Math.sign(point[0]) || 1;
  point[0] = sign * 0.9;
  flattened += 1;
}
console.log('ear verts flattened onto the head', flattened, 'body verts', source.length, 'tris', tris.length);

const head = source.filter((point) => point[1] > 6.15);
const vertex = extreme(head, (point) => point[1]);
const nose = extreme(head, (point) => point[2]);
const chin = extreme(
  source.filter((point) => point[1] > 5.9 && point[1] < 6.6 && Math.abs(point[0]) < 0.35 && point[2] > 1.05),
  (point) => -point[1],
);

const skull = readBin('/tmp/ent3d/skull.bin');
const skullVertex = extreme(skull, (point) => -point[1]);
const skullNose = extreme(skull, (point) => point[0]);
const midZ = (skullVertex[2] + skullNose[2]) / 2;
const skullChin = extreme(
  skull.filter((point) => point[0] > 100 && Math.abs(point[2] - midZ) < 22 && point[1] > 80 && point[1] < 150),
  (point) => point[1],
);
const mhHead = dist(vertex, chin);
const skullHead = dist(skullVertex, skullChin);
const scale = Math.min(1.02, Math.max(0.88, skullHead / mhHead / 100));
const sized = fitTranslation([
  { pre: premultiply(vertex).map((value) => value * scale), target: skullVertex, w: 3 },
  { pre: premultiply(chin).map((value) => value * scale), target: skullChin, w: 2 },
  { pre: premultiply(nose).map((value) => value * scale), target: skullNose, w: 1.2 },
]);
const fitScale = scale * sized.scale;
const translation = sized.translation;
console.log('fit', { scale: fitScale, translation, skullHead: skullHead.toFixed(1) });

function place(point) {
  const pre = premultiply(point);
  return [
    fitScale * pre[0] + translation[0],
    fitScale * pre[1] + translation[1],
    fitScale * pre[2] + translation[2],
  ];
}

const headCenter = [(skullVertex[0] + skullChin[0]) / 2, (skullVertex[1] + skullChin[1]) / 2, midZ];
const shell = 1.09;
let positions = source.map((point) => {
  const placed = place(point);
  if (point[1] < 6.15) return placed;
  return [
    headCenter[0] + (placed[0] - headCenter[0]) * shell + 11,
    headCenter[1] + (placed[1] - headCenter[1]) * shell,
    headCenter[2] + (placed[2] - headCenter[2]) * shell,
  ];
});

const eyeRadiusMm = Math.max(8, Math.min(13, eyeRadiusDm * fitScale * 100 * 1.05));
for (const eye of [leftEye, rightEye]) {
  const center = place(eye);
  const shelled = [
    headCenter[0] + (center[0] - headCenter[0]) * shell + 16,
    headCenter[1] + (center[1] - headCenter[1]) * shell,
    headCenter[2] + (center[2] - headCenter[2]) * shell,
  ];
  const ball = sphere(shelled, eyeRadiusMm, 12, 8);
  const base = positions.length;
  positions = positions.concat(ball.verts);
  for (const face of ball.faces) tris.push(face.map((index) => base + index));
}
console.log('eyeballs', eyeRadiusMm.toFixed(1), 'mm');

const weld = new Map();
const compact = [];
const remap = new Int32Array(positions.length);
positions.forEach((point, index) => {
  const key = point.map((value) => Math.round(value * 50)).join(',');
  let id = weld.get(key);
  if (id === undefined) {
    id = compact.length;
    weld.set(key, id);
    compact.push(point);
  }
  remap[index] = id;
});
const indices = [];
for (const face of tris) {
  const a = remap[face[0]];
  const b = remap[face[1]];
  const c = remap[face[2]];
  if (a === b || b === c || a === c) continue;
  indices.push(a, b, c);
}
console.log('welded verts', compact.length, 'tris', indices.length / 3);

const flat = new Float32Array(compact.length * 3);
compact.forEach((point, index) => {
  flat[index * 3] = point[0];
  flat[index * 3 + 1] = point[1];
  flat[index * 3 + 2] = point[2];
});
const indexArray = new Uint32Array(indices);
const bin = Buffer.alloc(8 + flat.byteLength + indexArray.byteLength);
bin.writeUInt32LE(compact.length, 0);
bin.writeUInt32LE(indices.length / 3, 4);
Buffer.from(flat.buffer).copy(bin, 8);
Buffer.from(indexArray.buffer).copy(bin, 8 + flat.byteLength);
const binPath = '/tmp/ent3d/skin.bin';
fs.writeFileSync(binPath, bin);
const glbPath = path.join(root, 'public/models/upper-body/skin.glb');
execFileSync('node', ['scripts/glb_codec.mjs', 'encode', binPath, glbPath, 'skin'], { cwd: root, stdio: 'inherit' });

const note = {
  license: 'CC0-1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  assetLicense: 'https://github.com/makehumancommunity/makehuman/blob/master/LICENSE.ASSETS.md',
  sourceFile: 'makehuman/data/3dobjs/base.obj',
  sourceUrl: 'https://github.com/makehumancommunity/makehuman/blob/master/makehuman/data/3dobjs/base.obj',
  meshName: 'hm08',
  group: 'body',
  dropped: 'helper and joint groups (hair, eyebrows, eyelashes, eyes, teeth, tongue, tights, skirt, joint cubes)',
  copyrightHolders: ['Data Collection AB', 'Joel Palmius', 'Jonas Hauquier'],
  released: '2020-09',
  note: 'Only the body group is kept. The base-mesh ears are flattened so the Z-Anatomy auricle is the ear. Orbits are closed with spheres. Vertices along split edges are welded so the midline normal is smooth. Unverified.',
  triangles: indices.length / 3,
  vertices: compact.length,
  fitScale,
  earToHelixMm: 0,
  review: '미검증',
};
fs.writeFileSync(path.join(root, 'public/models/upper-body/skin.json'), `${JSON.stringify(note, null, 2)}\n`);
console.log('wrote', glbPath, fs.statSync(glbPath).size);
