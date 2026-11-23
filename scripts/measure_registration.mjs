/**
 * Measure ZETA / Z-Anatomy landmark pairs and write registration.json.
 * Run: node --experimental-strip-types scripts/measure_registration.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairDistances, rms, umeyama, checkDimension } from '../src/shared/registration.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readBin(file) {
  const buf = fs.readFileSync(file);
  const vertexCount = buf.readUInt32LE(0);
  const faceCount = buf.readUInt32LE(4);
  const positions = new Float32Array(buf.buffer, buf.byteOffset + 8, vertexCount * 3);
  const pts = [];
  for (let i = 0; i < vertexCount; i += 1) pts.push([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
  return { pts, faceCount };
}

function decode(glb) {
  const bin = glb.replace(/\.glb$/, '.bin');
  const out = `/tmp/ent3d/${path.basename(bin)}`;
  return out;
}

function nearest(pts, target) {
  let best = Infinity;
  let p = pts[0];
  for (const point of pts) {
    const d = Math.hypot(point[0] - target[0], point[1] - target[1], point[2] - target[2]);
    if (d < best) {
      best = d;
      p = point;
    }
  }
  return { p: p.slice(), d: best };
}

function round3(p) {
  return p.map((value) => Math.round(value * 1000) / 1000);
}

const skull = readBin('/tmp/ent3d/skull.bin').pts;
const bone = readBin('/tmp/ent3d/bone.bin').pts;
const malleus = readBin('/tmp/ent3d/malleus.bin').pts;
const auricle = readBin('/tmp/ent3d/auricle.bin').pts;
const landmarks = JSON.parse(fs.readFileSync(path.join(root, 'public/temporal-bone/landmarks.json'), 'utf8'));
const byId = Object.fromEntries(landmarks.landmarks.map((item) => [item.id, item.xyz_mm]));

const zetaEac = byId['eac-porus'];
const zetaMastoid = byId['mastoid-tip'];
const zetaZyg = byId['zygomatic-root'];
const zetaSmf = byId['stylomastoid-foramen'];

let minY = Infinity;
let vertex = skull[0];
let maxX = -Infinity;
let nose = skull[0];
for (const p of skull) {
  if (p[1] < minY) {
    minY = p[1];
    vertex = p;
  }
  if (p[0] > maxX) {
    maxX = p[0];
    nose = p;
  }
}
const midZ = (vertex[2] + nose[2]) / 2;

const cell = 2;
const occ = new Map();
for (const p of skull) {
  if (p[0] < 8 || p[0] > 48 || p[1] < 4 || p[1] > 46 || p[2] < 8 || p[2] > 36) continue;
  const key = `${Math.round(p[0] / cell)},${Math.round(p[1] / cell)}`;
  const prev = occ.get(key);
  if (!prev || p[2] < prev[2]) occ.set(key, p);
}
const holes = [];
for (let ix = 8; ix <= 20; ix += 1) {
  for (let iy = 6; iy <= 16; iy += 1) {
    const key = `${ix},${iy}`;
    if (occ.has(key)) continue;
    let nbr = 0;
    const around = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        if (!dx && !dy) continue;
        const hit = occ.get(`${ix + dx},${iy + dy}`);
        if (hit && hit[2] < 30) {
          nbr += 1;
          around.push(hit);
        }
      }
    }
    if (nbr >= 5) holes.push({ x: ix * cell, y: iy * cell, nbr, around });
  }
}
if (!holes.length) throw new Error('right meatus not found');
holes.sort((a, b) => b.nbr - a.nbr || a.y - b.y);
const hole = holes[0];
const rim = hole.around;
const porionGuess = [0, 0, 0];
for (const p of rim) {
  porionGuess[0] += p[0];
  porionGuess[1] += p[1];
  porionGuess[2] += p[2];
}
porionGuess[0] /= rim.length;
porionGuess[1] /= rim.length;
porionGuess[2] /= rim.length;
const skullEac = nearest(skull, porionGuess).p;
console.error('meatus', { holes: holes.slice(0, 6), porionGuess, skullEac });

const mastoidPool = skull.filter(
  (p) =>
    p[1] > skullEac[1] + 18 &&
    p[1] < skullEac[1] + 48 &&
    Math.abs(p[0] - skullEac[0]) < 22 &&
    p[2] > skullEac[2] - 14 &&
    p[2] < skullEac[2] + 18,
);
if (!mastoidPool.length) throw new Error('mastoid tip not found');
mastoidPool.sort((a, b) => b[1] - a[1]);
const skullMastoid = mastoidPool[0];
console.error('mastoid', skullMastoid, 'pool', mastoidPool.length);

const zygPool = skull.filter((p) => p[0] > 34 && p[0] < 58 && p[1] > 10 && p[1] < 34 && p[2] > 16 && p[2] < 40);
zygPool.sort((a, b) => a[2] + Math.abs(a[1] - skullEac[1]) * 0.2 - (b[2] + Math.abs(b[1] - skullEac[1]) * 0.2));
const skullZyg = zygPool[0];

const smfOffset = [
  zetaSmf[0] - zetaEac[0],
  zetaSmf[1] - zetaEac[1],
  zetaSmf[2] - zetaEac[2],
];
const skullSmf = nearest(skull, [
  skullEac[0] + smfOffset[0],
  skullEac[1] + smfOffset[1],
  skullEac[2] + smfOffset[2],
]).p;

let tip = bone[0];
for (const p of bone) if (p[1] > tip[1] && p[2] > 28) tip = p;
const toward = [zetaSmf[0] - tip[0], zetaSmf[1] - tip[1], zetaSmf[2] - tip[2]];
const towardLen = Math.hypot(...toward) || 1;
const baseGuess = [
  tip[0] + (toward[0] / towardLen) * (towardLen - 10),
  tip[1] + (toward[1] / towardLen) * (towardLen - 10),
  tip[2] + (toward[2] / towardLen) * (towardLen - 10),
];
const zetaStyloid = nearest(bone, baseGuess).p;
const styloidOffset = [
  zetaStyloid[0] - zetaEac[0],
  zetaStyloid[1] - zetaEac[1],
  zetaStyloid[2] - zetaEac[2],
];
const skullStyloid = nearest(skull, [
  skullEac[0] + styloidOffset[0],
  skullEac[1] + styloidOffset[1],
  skullEac[2] + styloidOffset[2],
]).p;

const pairs = [
  {
    id: 'eac-porus',
    en: 'EAC porus',
    ko: '외이도 입구',
    method: 'ZETA canal centroid. Skull: centroid of the lateral rim vertices of the right meatus, snapped to the nearest surface vertex.',
    zetaMm: round3(zetaEac),
    skullMm: round3(skullEac),
  },
  {
    id: 'mastoid-tip',
    en: 'Mastoid tip',
    ko: '유양돌기 첨부',
    method: 'ZETA posterolateral inferior landmark. Skull: most inferior vertex of the right mastoid region.',
    zetaMm: round3(zetaMastoid),
    skullMm: round3(skullMastoid),
  },
  {
    id: 'zygomatic-root',
    en: 'Zygomatic root',
    ko: '관골돌기 기시부',
    method: 'ZETA manual landmark. Skull: lateral surface just anterior to the meatus, at meatus height.',
    zetaMm: round3(zetaZyg),
    skullMm: round3(skullZyg),
  },
  {
    id: 'stylomastoid-foramen',
    en: 'Stylomastoid foramen',
    ko: '경유돌공',
    method: 'ZETA distal facial-nerve landmark. Skull: same offset from the skull porion, snapped to the surface. The foramen itself is not resolved on the decimated skull.',
    zetaMm: round3(zetaSmf),
    skullMm: round3(skullSmf),
  },
  {
    id: 'styloid-base',
    en: 'Styloid base',
    ko: '경상돌기 기저',
    method: 'ZETA: bone vertex about 10 mm from the styloid tip back toward the stylomastoid foramen. Skull: same offset from the porion, snapped to the surface. The thin styloid is mostly lost on the decimated skull.',
    zetaMm: round3(zetaStyloid),
    skullMm: round3(skullStyloid),
  },
];

const skullPts = pairs.map((pair) => pair.skullMm);
const zetaPts = pairs.map((pair) => pair.zetaMm);
const current = pairDistances(skullPts, zetaPts);
pairs.forEach((pair, index) => {
  pair.residualMm = Math.round(current[index] * 1000) / 1000;
});
const fit = umeyama(skullPts, zetaPts);
const withoutMastoid = pairs.map((pair, index) => index).filter((index) => pairs[index].id !== 'mastoid-tip');
const fitNoMastoid = umeyama(
  withoutMastoid.map((index) => skullPts[index]),
  withoutMastoid.map((index) => zetaPts[index]),
);

function chord(pts) {
  let best = 0;
  const step = Math.max(1, Math.floor(pts.length / 1800));
  for (let i = 0; i < pts.length; i += step) {
    for (let j = i + step; j < pts.length; j += step) {
      const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]);
      if (d > best) best = d;
    }
  }
  return best;
}

const vault = skull.filter((p) => Math.abs(p[2] - midZ) < 15 && p[1] > -40 && p[1] < 20);
let post = vault[0];
let ant = vault[0];
for (const p of vault) {
  if (p[0] < post[0]) post = p;
  if (p[0] > ant[0]) ant = p;
}
const gol = ant[0] - post[0];
const arches = skull.filter((p) => p[1] > 5 && p[1] < 45 && p[0] > 40 && p[0] < 120);
let zMin = Infinity;
let zMax = -Infinity;
for (const p of arches) {
  if (p[2] < zMin) zMin = p[2];
  if (p[2] > zMax) zMax = p[2];
}
const zyb = zMax - zMin;
const malleusMm = chord(malleus);
const mastoidDrop = zetaMastoid[1] - zetaEac[1];
const skullDrop = skullMastoid[1] - skullEac[1];
let aurMinY = Infinity;
let aurMaxY = -Infinity;
for (const p of auricle) {
  if (p[1] < aurMinY) aurMinY = p[1];
  if (p[1] > aurMaxY) aurMaxY = p[1];
}

const dimensions = [
  {
    ...checkDimension('zeta-malleus-chord', Math.round(malleusMm * 100) / 100, 7.92, 0.55),
    model: 'ZETA malleus',
    source: 'Singh et al., J Anat Soc India morphometry, mean total length 7.915 mm (n=120). Compared with the longest vertex chord. Acceptance is |z| < 2.5. A CBCT series (Natl J Maxillofac Surg 2024) reported range 4.5–9.0 mm.',
  },
  {
    ...checkDimension('zeta-mastoid-drop', Math.round(mastoidDrop * 100) / 100, 32.3, 3.1),
    model: 'ZETA mastoid',
    source: 'Lopes et al., Research Society and Development 2021, male porion–mastoidale mean about 32 mm (right 31.63 SD 3.09, left 32.96 SD 2.93). This value is the vertical drop from the canal centroid, not caliper porion, so it is only a scale check.',
  },
  {
    ...checkDimension('zanatomy-gol', Math.round(gol * 100) / 100, 186, 8),
    model: 'Z-Anatomy skull',
    source: 'Howells cranial length. Egyptian male mean GOL 185.6 mm and Norse male mean 188.5 mm (Howells craniometric set). SD 8 mm stands in for cross-population spread. Glabella and opisthocranion here are the anterior and posterior midline vault vertices.',
  },
  {
    ...checkDimension('zanatomy-zyb', Math.round(zyb * 100) / 100, 132, 6),
    model: 'Z-Anatomy skull',
    source: 'Bizygomatic breadth. Howells male examples are about 133–134 mm; a Brazilian male mean is 128.2 mm SD 5.5 (Lopes 2021). SD 6 mm is the acceptance window. Measured across the zygomatic arches, not the clavicles.',
  },
  {
    ...checkDimension('zanatomy-auricle-height', Math.round((aurMaxY - aurMinY) * 100) / 100, 62, 5),
    model: 'Z-Anatomy auricle',
    source: 'Adult auricular length is commonly near 60 mm. SD 5 mm flags only a large miss. This is cartilage height, top of helix to lobule.',
  },
  {
    ...checkDimension('skull-mastoid-drop', Math.round(skullDrop * 100) / 100, 32.3, 3.1),
    model: 'Z-Anatomy mastoid',
    source: 'Same porion–mastoidale reference as the ZETA drop. Skull porion is the lateral meatus rim, so this is closer to the caliper definition than the canal centroid.',
  },
].map((item) => ({
  id: item.id,
  model: item.model,
  valueMm: Math.round(item.valueMm * 100) / 100,
  meanMm: item.meanMm,
  sdMm: item.sdMm,
  z: Math.round(item.z * 100) / 100,
  flagged: item.flagged,
  source: item.source,
}));

const eacToZeta = Math.hypot(
  zetaMastoid[0] - zetaEac[0],
  zetaMastoid[1] - zetaEac[1],
  zetaMastoid[2] - zetaEac[2],
);
const eacToSkull = Math.hypot(
  skullMastoid[0] - skullEac[0],
  skullMastoid[1] - skullEac[1],
  skullMastoid[2] - skullEac[2],
);
const twoPointScale = eacToZeta / eacToSkull;

const report = {
  review: '미검증',
  scale: 1,
  appliedScale: 1,
  within5Percent: Math.abs(fit.scale - 1) <= 0.05,
  rawUmeyamaScale: fit.scale,
  twoPointMastoidScale: twoPointScale,
  previousRawScaleFromMastoid: 0.75,
  scaleDecision:
    'Neither mesh was rescaled. The two-point mastoid ratio is 0.76, the old 0.75 figure: both Z-Anatomy mastoid tips sit about 44 mm below the porion, against a male porion–mastoidale mean near 32 mm, while the ZETA drop is 33 mm. Applying 0.76 would shrink a 191 mm skull to about 145 mm and an 8.7 mm malleus to about 6.6 mm. Cranial length, bizygomatic breadth, and auricle height are not flagged. Umeyama on five pairs is scale 0.86 (RMS 4.9 mm), pulled by that mastoid. Without the mastoid the scale is 1.11 (RMS 1.3 mm), a local difference between two adults, not a unit error. Neither scale is applied. The entry scene stays at scale 1, anchored on the ear canal.',
  umeyamaWithoutMastoid: {
    scale: fitNoMastoid.scale,
    rmsMm: Math.round(fitNoMastoid.rmsMm * 1000) / 1000,
  },
  petrousApex:
    'Not paired. The medial edge of the ZETA bone is a crop near z = 59 mm, not a tapering petrous apex, and the decimated skull has no internal petrous surface.',
  current: {
    method: 'Scale 1. Translation only, so the Z-Anatomy right meatus sits on the ZETA canal centroid. No rotation.',
    rmsMm: Math.round(rms(current) * 1000) / 1000,
    pairs,
  },
  umeyama: {
    scale: fit.scale,
    rotation: fit.rotation,
    translationMm: fit.translation,
    rmsMm: Math.round(fit.rmsMm * 1000) / 1000,
    residualsMm: fit.residualsMm.map((value) => Math.round(value * 1000) / 1000),
    note: 'Least-squares similarity from the skull points onto the ZETA points. Reported only. Not applied, because the ear-canal anchor is what the entry scene uses and the scale is not a unit correction.',
  },
  dimensions,
  vertexMm: round3(vertex),
  noseMm: round3(nose),
  midZ: Math.round(midZ * 1000) / 1000,
  source: 'Z-Anatomy Startup.blend extract, CC BY-SA 4.0, derived from BodyParts3D CC BY-SA 2.1 JP. Skull, mandible, cervical vertebrae, clavicles, right auricle cartilage. No skin in that template.',
};

fs.writeFileSync(path.join(root, 'public/models/upper-body/registration.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  rms: report.current.rmsMm,
  umeyamaScale: fit.scale,
  umeyamaRms: fit.rmsMm,
  twoPointScale,
  pairs: pairs.map((pair) => ({ id: pair.id, residual: pair.residualMm, skull: pair.skullMm, zeta: pair.zetaMm })),
  dimensions,
}, null, 2));
