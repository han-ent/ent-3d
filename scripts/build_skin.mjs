/**
 * Crop the CC0 MakeHuman hm08 base mesh to the head, neck, and shoulders,
 * fit it to the Z-Anatomy skull, and write a Draco GLB.
 *
 * Expects /tmp/ent3d/base.obj and decoded skull.bin / auricle.bin.
 * Run: node scripts/build_skin.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const objPath = '/tmp/ent3d/base.obj';

function readBin(file) {
  const buf = fs.readFileSync(file);
  const vertexCount = buf.readUInt32LE(0);
  const faceCount = buf.readUInt32LE(4);
  const positions = new Float32Array(buf.buffer, buf.byteOffset + 8, vertexCount * 3);
  const indices = new Uint32Array(buf.buffer, buf.byteOffset + 8 + vertexCount * 12, faceCount * 3);
  const pts = [];
  for (let i = 0; i < vertexCount; i += 1) pts.push([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
  return { pts, indices: new Uint32Array(indices) };
}

function solve4(matrix, vector) {
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < 4; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 4; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error('singular fit');
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const div = a[col][col];
    for (let k = col; k < 5; k += 1) a[col][k] /= div;
    for (let row = 0; row < 4; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let k = col; k < 5; k += 1) a[row][k] -= factor * a[col][k];
    }
  }
  return a.map((row) => row[4]);
}

function fitScaleTranslation(pairs) {
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

function applyFit(point, fit) {
  const pre = premultiply(point);
  return [
    fit.scale * pre[0] + fit.translation[0],
    fit.scale * pre[1] + fit.translation[1],
    fit.scale * pre[2] + fit.translation[2],
  ];
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

const text = fs.readFileSync(objPath, 'utf8');
const mh = [];
const faces = [];
for (const line of text.split('\n')) {
  if (line.startsWith('v ')) {
    mh.push(line.trim().split(/\s+/).slice(1, 4).map(Number));
  } else if (line.startsWith('f ')) {
    const corners = line
      .trim()
      .split(/\s+/)
      .slice(1)
      .map((token) => Number(token.split('/')[0]) - 1);
    if (corners.length === 3) faces.push(corners);
    else if (corners.length === 4) faces.push([corners[0], corners[1], corners[2]], [corners[0], corners[2], corners[3]]);
  }
}

function keepVertex(point) {
  if (point[1] < 4.7) return false;
  if (point[1] < 6.05 && Math.abs(point[0]) > 1.95) return false;
  return true;
}

const kept = new Int32Array(mh.length).fill(-1);
const source = [];
mh.forEach((point, index) => {
  if (!keepVertex(point)) return;
  kept[index] = source.length;
  source.push(point);
});
const tris = [];
for (const face of faces) {
  const a = kept[face[0]];
  const b = kept[face[1]];
  const c = kept[face[2]];
  if (a < 0 || b < 0 || c < 0) continue;
  tris.push(a, b, c);
}
console.log('cropped verts', source.length, 'tris', tris.length / 3);

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

const head = source.filter((point) => point[1] > 6.05);
const vertex = extreme(head, (point) => point[1]);
const nose = extreme(head, (point) => point[2]);
const chinPool = source.filter((point) => point[1] > 5.9 && point[1] < 6.5 && Math.abs(point[0]) < 0.35 && point[2] > 1.1);
const chin = extreme(chinPool, (point) => -point[1]);
const earBand = source.filter((point) => point[1] > 6.25 && point[1] < 6.75 && point[2] < 0.45);
const rightEar = extreme(earBand, (point) => -point[0]);
const leftEar = extreme(earBand, (point) => point[0]);

const skull = readBin('/tmp/ent3d/skull.bin');
const auricle = readBin('/tmp/ent3d/auricle.bin');
const skullVertex = extreme(skull.pts, (point) => -point[1]);
const skullNose = extreme(skull.pts, (point) => point[0]);
const midZ = (skullVertex[2] + skullNose[2]) / 2;
const skullChinPool = skull.pts.filter((point) => point[0] > 100 && Math.abs(point[2] - midZ) < 22 && point[1] > 80 && point[1] < 150);
const skullChin = extreme(skullChinPool, (point) => point[1]);
const aurLateral = extreme(auricle.pts, (point) => -point[2]);
const auricleCenter = [0, 0, 0];
for (const point of auricle.pts) {
  auricleCenter[0] += point[0];
  auricleCenter[1] += point[1];
  auricleCenter[2] += point[2];
}
auricleCenter[0] /= auricle.pts.length;
auricleCenter[1] /= auricle.pts.length;
auricleCenter[2] /= auricle.pts.length;
const leftTarget = [aurLateral[0], aurLateral[1], midZ + (midZ - aurLateral[2])];

const mhHead = dist(vertex, chin);
const skullHead = dist(skullVertex, skullChin);
const mhEars = dist(leftEar, rightEar);
const skullEars = dist(aurLateral, leftTarget);
const scale = Math.min(1.05, Math.max(0.85, (skullHead / mhHead + skullEars / (mhEars || 1)) / 2 / 100));
const anchored = fitScaleTranslation([
  { pre: premultiply(vertex).map((value) => value * scale), target: skullVertex, w: 3 },
  { pre: premultiply(chin).map((value) => value * scale), target: skullChin, w: 2 },
  { pre: premultiply(nose).map((value) => value * scale), target: skullNose, w: 1 },
]);
const fit = { scale: scale * anchored.scale, translation: anchored.translation };
console.log('fit', { scale, anchoredScale: anchored.scale, translation: fit.translation, skullHead, mhHeadMm: mhHead * 100 });

const placed = source.map((point) => applyFit(point, fit));
const earIds = [];
source.forEach((point, index) => {
  if (point[0] < -0.95 && point[1] > 5.95 && point[1] < 7.05 && point[2] < 0.4 && point[2] > -0.35) earIds.push(index);
});
const earMh = earIds.map((index) => source[index]);
const aurMin = [Infinity, Infinity, Infinity];
const aurMax = [-Infinity, -Infinity, -Infinity];
for (const point of auricle.pts) {
  for (let axis = 0; axis < 3; axis += 1) {
    if (point[axis] < aurMin[axis]) aurMin[axis] = point[axis];
    if (point[axis] > aurMax[axis]) aurMax[axis] = point[axis];
  }
}
aurMin[2] -= 1.5;
const earMin = [Infinity, Infinity, Infinity];
const earMax = [-Infinity, -Infinity, -Infinity];
for (const index of earIds) {
  const point = placed[index];
  for (let axis = 0; axis < 3; axis += 1) {
    if (point[axis] < earMin[axis]) earMin[axis] = point[axis];
    if (point[axis] > earMax[axis]) earMax[axis] = point[axis];
  }
}
const earCenter = [0, 0, 0];
for (const index of earIds) {
  earCenter[0] += placed[index][0];
  earCenter[1] += placed[index][1];
  earCenter[2] += placed[index][2];
}
earCenter[0] /= earIds.length;
earCenter[1] /= earIds.length;
earCenter[2] /= earIds.length;
const axisScale = [0, 1, 2].map((axis) => {
  const from = Math.max(earMax[axis] - earMin[axis], 8);
  const to = Math.max(aurMax[axis] - aurMin[axis], 8);
  return Math.max(0.85, Math.min(1.6, to / from));
});
console.log('ear verts', earIds.length, 'axis scales', axisScale.map((value) => value.toFixed(2)).join(','));
console.log('earCenter', earCenter.map((value) => value.toFixed(1)).join(','));
console.log('auricleCenter', auricleCenter.map((value) => value.toFixed(1)).join(','));
console.log('aur bbox', aurMin.map((value) => value.toFixed(1)).join(','), aurMax.map((value) => value.toFixed(1)).join(','));

function earWeight(point) {
  let nearest = Infinity;
  for (const ear of earMh) {
    const d = dist(point, ear);
    if (d < nearest) nearest = d;
  }
  if (nearest < 0.03) return 1;
  if (nearest > 0.22) return 0;
  const t = (nearest - 0.03) / 0.19;
  return (1 - t) * (1 - t);
}

for (let i = 0; i < placed.length; i += 1) {
  const weight = earWeight(source[i]);
  if (weight <= 0) continue;
  const point = placed[i];
  const grown = [
    auricleCenter[0] + (point[0] - earCenter[0]) * axisScale[0],
    auricleCenter[1] + (point[1] - earCenter[1]) * axisScale[1],
    auricleCenter[2] + (point[2] - earCenter[2]) * axisScale[2],
  ];
  placed[i] = [
    point[0] + (grown[0] - point[0]) * weight,
    point[1] + (grown[1] - point[1]) * weight,
    point[2] + (grown[2] - point[2]) * weight,
  ];
}
for (let i = 0; i < placed.length; i += 1) {
  const weight = earWeight(source[i]);
  if (weight < 0.15) continue;
  const point = placed[i];
  placed[i] = [point[0], point[1], point[2] - 18 * weight];
}
const rightAfter = placed[source.indexOf(rightEar)];
console.log('helix error after warp', dist(rightAfter, aurLateral).toFixed(2), 'mm');

const normals = skull.pts.map(() => [0, 0, 0]);
for (let face = 0; face < skull.indices.length; face += 3) {
  const ia = skull.indices[face];
  const ib = skull.indices[face + 1];
  const ic = skull.indices[face + 2];
  const a = skull.pts[ia];
  const b = skull.pts[ib];
  const c = skull.pts[ic];
  const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
  const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (const index of [ia, ib, ic]) {
    normals[index][0] += nx;
    normals[index][1] += ny;
    normals[index][2] += nz;
  }
}
for (const normal of normals) {
  const length = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  normal[0] /= length;
  normal[1] /= length;
  normal[2] /= length;
}

const cell = 12;
const grid = new Map();
skull.pts.forEach((point, index) => {
  const key = `${Math.floor(point[0] / cell)},${Math.floor(point[1] / cell)},${Math.floor(point[2] / cell)}`;
  const list = grid.get(key);
  if (list) list.push(index);
  else grid.set(key, [index]);
});

function nearestSkull(point) {
  const ix = Math.floor(point[0] / cell);
  const iy = Math.floor(point[1] / cell);
  const iz = Math.floor(point[2] / cell);
  let best = Infinity;
  let index = -1;
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dz = -2; dz <= 2; dz += 1) {
        const list = grid.get(`${ix + dx},${iy + dy},${iz + dz}`);
        if (!list) continue;
        for (const candidate of list) {
          const other = skull.pts[candidate];
          const d = (other[0] - point[0]) ** 2 + (other[1] - point[1]) ** 2 + (other[2] - point[2]) ** 2;
          if (d < best) {
            best = d;
            index = candidate;
          }
        }
      }
    }
  }
  return index;
}

const headCenter = [(skullVertex[0] + skullChin[0]) / 2, (skullVertex[1] + skullChin[1]) / 2, midZ];
function binRadius(points) {
  const bins = new Map();
  for (const point of points) {
    const d = [point[0] - headCenter[0], point[1] - headCenter[1], point[2] - headCenter[2]];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    const pitch = Math.round((Math.asin(Math.max(-1, Math.min(1, d[1] / len))) / Math.PI) * 8);
    const yaw = Math.round((Math.atan2(d[2], d[0]) / Math.PI) * 8);
    const key = `${pitch},${yaw}`;
    bins.set(key, Math.max(bins.get(key) ?? 0, len));
  }
  return bins;
}
const skullBins = binRadius(skull.pts.filter((point) => point[1] < skullChin[1] + 15 && point[1] > skullVertex[1] - 5));
const skinHead = placed.filter((_, index) => source[index][1] > 6.3);
const skinBins = binRadius(skinHead);
const gaps = [];
for (const [key, radius] of skullBins) {
  const skinRadius = skinBins.get(key);
  if (skinRadius) gaps.push(skinRadius - radius);
}
gaps.sort((a, b) => a - b);
const medianGap = gaps[Math.floor(gaps.length / 2)] ?? 0;
console.log('median skin-skull gap', medianGap.toFixed(1), 'mm over', gaps.length, 'bins');
const factor = 1.07;
for (let i = 0; i < placed.length; i += 1) {
  if (source[i][1] < 6.2) continue;
  if (earWeight(source[i]) > 0.8) continue;
  const point = placed[i];
  placed[i] = [
    headCenter[0] + (point[0] - headCenter[0]) * factor + 8,
    headCenter[1] + (point[1] - headCenter[1]) * factor,
    headCenter[2] + (point[2] - headCenter[2]) * factor,
  ];
}
console.log('head shell', factor, 'median gap was', medianGap.toFixed(1));

const nosePlaced = applyFit(nose, fit);
let noseNormalX = 0;
let noseCount = 0;
for (let face = 0; face < tris.length; face += 3) {
  const a = placed[tris[face]];
  const b = placed[tris[face + 1]];
  const c = placed[tris[face + 2]];
  const mid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  if (dist(mid, nosePlaced) > 18) continue;
  const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
  noseNormalX += nx;
  noseCount += 1;
}
if (noseCount && noseNormalX < 0) {
  for (let face = 0; face < tris.length; face += 3) {
    const swap = tris[face + 1];
    tris[face + 1] = tris[face + 2];
    tris[face + 2] = swap;
  }
  console.log('flipped winding');
}

let positions = placed;
let indices = new Uint32Array(tris);
let triangleCount = indices.length / 3;
if (triangleCount > 28000) {
  const size = 2.2;
  const buckets = new Map();
  const remap = new Int32Array(positions.length).fill(-1);
  const compact = [];
  positions.forEach((point, index) => {
    const key = `${Math.round(point[0] / size)},${Math.round(point[1] / size)},${Math.round(point[2] / size)}`;
    let id = buckets.get(key);
    if (id === undefined) {
      id = compact.length;
      buckets.set(key, id);
      compact.push([point[0], point[1], point[2], 1]);
    } else {
      compact[id][0] += point[0];
      compact[id][1] += point[1];
      compact[id][2] += point[2];
      compact[id][3] += 1;
    }
    remap[index] = id;
  });
  positions = compact.map((point) => [point[0] / point[3], point[1] / point[3], point[2] / point[3]]);
  const next = [];
  for (let face = 0; face < indices.length; face += 3) {
    const a = remap[indices[face]];
    const b = remap[indices[face + 1]];
    const c = remap[indices[face + 2]];
    if (a === b || b === c || a === c) continue;
    next.push(a, b, c);
  }
  indices = new Uint32Array(next);
  triangleCount = indices.length / 3;
  console.log('decimated to', triangleCount);
}

const earAfter = placed[source.indexOf(rightEar)] ?? positions[0];
const earError = dist(applyFit(rightEar, fit) && earAfter, aurLateral);
console.log('triangles', triangleCount, 'ear landmark still', dist(earAfter, aurLateral).toFixed(2), 'mm from helix');

const flat = new Float32Array(positions.length * 3);
positions.forEach((point, index) => {
  flat[index * 3] = point[0];
  flat[index * 3 + 1] = point[1];
  flat[index * 3 + 2] = point[2];
});
const bin = Buffer.alloc(8 + flat.byteLength + indices.byteLength);
bin.writeUInt32LE(positions.length, 0);
bin.writeUInt32LE(indices.length / 3, 4);
Buffer.from(flat.buffer).copy(bin, 8);
Buffer.from(indices.buffer).copy(bin, 8 + flat.byteLength);
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
  copyrightHolders: ['Data Collection AB', 'Joel Palmius', 'Jonas Hauquier'],
  released: '2020-09',
  note: 'The base.obj header says the asset was explicitly released as CC0 in September 2020. Cropped to the head, neck, and shoulders, fitted by scale and translation in the ZETA millimetre frame, with a local ear warp onto the right auricle and a small push off the skull. Unverified.',
  triangles: triangleCount,
  vertices: positions.length,
  fitScale: fit.scale,
  earToHelixMm: Math.round(dist(earAfter, aurLateral) * 100) / 100,
  review: '미검증',
};
fs.writeFileSync(path.join(root, 'public/models/upper-body/skin.json'), `${JSON.stringify(note, null, 2)}\n`);
console.log('wrote', glbPath, fs.statSync(glbPath).size, 'bytes');
