import type { Vec3 } from './types';
import { isOutsideAabb, verticalSpanMm } from './view-pose';

export type ViewStage = 'body' | 'ear' | 'bone' | 'inner';

export type Aabb = { min: Vec3; max: Vec3 };

export function aabbCenter(box: Aabb): Vec3 {
  return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
}

function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function norm(v: Vec3): Vec3 {
  const scale = length(v) || 1;
  return [v[0] / scale, v[1] / scale, v[2] / scale];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export type StageView = {
  /** From the target toward the camera. Lateral is −Z, superior is −Y. */
  direction: Vec3;
  up: Vec3;
  fov: number;
  margin: number;
};

/** Lateral views. The inner-ear camera sits above and slightly behind the labyrinth. */
export const STAGE_VIEW: Record<ViewStage, StageView> = {
  body: { direction: [0.2, -0.05, -1], up: [0, -1, 0], fov: 32, margin: 1.18 },
  ear: { direction: [0.12, -0.18, -1], up: [0, -1, 0], fov: 32, margin: 1.32 },
  bone: { direction: [0.2, -0.28, -1], up: [0, -1, 0], fov: 32, margin: 1.22 },
  inner: { direction: [-0.2, -0.42, -1], up: [0, -1, 0], fov: 32, margin: 1.48 },
};

/**
 * Fit a box in the view. Narrow phones step the camera back so the target
 * stays on screen; the fit uses both the vertical and the horizontal field.
 */
export function frameAabb(options: {
  box: Aabb;
  direction: Vec3;
  up: Vec3;
  fovDeg: number;
  viewWidthPx: number;
  viewHeightPx: number;
  margin?: number;
}): { position: Vec3; target: Vec3; distance: number } {
  const margin = options.margin ?? 1.3;
  const target = aabbCenter(options.box);
  const towardCamera = norm(options.direction);
  const look: Vec3 = [-towardCamera[0], -towardCamera[1], -towardCamera[2]];
  let up = norm(options.up);
  const right = norm(cross(look, up));
  up = norm(cross(right, look));
  let halfW = 0.5;
  let halfH = 0.5;
  for (const x of [options.box.min[0], options.box.max[0]]) {
    for (const y of [options.box.min[1], options.box.max[1]]) {
      for (const z of [options.box.min[2], options.box.max[2]]) {
        const rel: Vec3 = [x - target[0], y - target[1], z - target[2]];
        halfW = Math.max(halfW, Math.abs(dot(rel, right)));
        halfH = Math.max(halfH, Math.abs(dot(rel, up)));
      }
    }
  }
  const aspect = Math.max(options.viewWidthPx, 1) / Math.max(options.viewHeightPx, 1);
  const tanV = Math.tan((options.fovDeg * Math.PI) / 360);
  const tanH = Math.max(tanV * aspect, 1e-4);
  let distance = Math.max((halfH * margin) / tanV, (halfW * margin) / tanH, 12);
  let position: Vec3 = [
    target[0] + towardCamera[0] * distance,
    target[1] + towardCamera[1] * distance,
    target[2] + towardCamera[2] * distance,
  ];
  let guard = 0;
  while (!isOutsideAabb(position, options.box.min, options.box.max) && guard < 6) {
    distance *= 1.3;
    position = [
      target[0] + towardCamera[0] * distance,
      target[1] + towardCamera[1] * distance,
      target[2] + towardCamera[2] * distance,
    ];
    guard += 1;
  }
  return { position, target, distance };
}

/** True when every corner of the box lands inside the perspective view. */
export function boxFitsView(
  box: Aabb,
  position: Vec3,
  target: Vec3,
  up: Vec3,
  fovDeg: number,
  viewWidthPx: number,
  viewHeightPx: number,
  slack = 1.04,
): boolean {
  const toward: Vec3 = [position[0] - target[0], position[1] - target[1], position[2] - target[2]];
  const distance = length(toward) || 1;
  const look: Vec3 = [-toward[0] / distance, -toward[1] / distance, -toward[2] / distance];
  let camUp = norm(up);
  const right = norm(cross(look, camUp));
  camUp = norm(cross(right, look));
  const aspect = Math.max(viewWidthPx, 1) / Math.max(viewHeightPx, 1);
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const tanH = tanV * aspect;
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) {
        const rel: Vec3 = [x - target[0], y - target[1], z - target[2]];
        const depth = dot(rel, look);
        const plane = distance + depth;
        if (plane <= 1) return false;
        const px = Math.abs(dot(rel, right));
        const py = Math.abs(dot(rel, camUp));
        if (px > plane * tanH * slack) return false;
        if (py > plane * tanV * slack) return false;
      }
    }
  }
  return true;
}

/** On a tall phone, step back along the authored direction so the field still fits the width. */
export function distanceForAspect(authoredDistance: number, fovDeg: number, viewWidthPx: number, viewHeightPx: number): number {
  const aspect = Math.max(viewWidthPx, 1) / Math.max(viewHeightPx, 1);
  if (aspect >= 0.95) return authoredDistance;
  const span = verticalSpanMm(authoredDistance, fovDeg);
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const tanH = Math.max(tanV * aspect, 1e-4);
  const forWidth = span / (2 * tanH);
  return Math.max(authoredDistance, forWidth);
}

export function placeAlong(target: Vec3, direction: Vec3, distance: number): Vec3 {
  const scale = length(direction) || 1;
  return [target[0] + (direction[0] / scale) * distance, target[1] + (direction[1] / scale) * distance, target[2] + (direction[2] / scale) * distance];
}

const INNER_STRUCTURES = new Set([
  'labyrinth',
  'scala-vestibuli',
  'scala-vestibuli-basal',
  'scala-vestibuli-middle',
  'scala-vestibuli-apical',
  'scala-tympani',
  'scala-tympani-basal',
  'scala-tympani-middle',
  'scala-tympani-apical',
  'vestibule',
  'scc-lateral',
  'scc-superior',
  'scc-posterior',
  'common-crus',
  'facial-nerve',
  'fn-labyrinthine',
  'fn-geniculate',
  'fn-tympanic',
  'fn-second-genu',
  'fn-mastoid',
  'cochleovestibular-nerve',
]);

const SHELL_STRUCTURES = new Set([
  'malleus',
  'incus',
  'stapes',
  'tympanic-membrane',
  'tm-pars-tensa',
  'tm-pars-flaccida',
  'external-auditory-canal',
  'sinus-dura',
  'carotid-artery',
  'chorda-tympani',
]);

/** Structures hidden on a crumb stage. The inner-ear stage keeps the labyrinth and the facial nerve. */
export function hiddenForStage(stage: ViewStage, ids: readonly string[]): string[] {
  if (stage === 'body' || stage === 'ear') return [...ids];
  if (stage === 'bone') return [];
  return ids.filter((id) => SHELL_STRUCTURES.has(id));
}

const OUTSIDE_BONE = new Set(['bone', 'sinus-dura', 'carotid-artery', 'external-auditory-canal']);

export function structureStages(id: string, layer: string): ViewStage[] {
  if (id === 'facial-nerve' || id.startsWith('fn-')) return ['inner', 'bone'];
  if (INNER_STRUCTURES.has(id) || layer === 'inner-ear') return ['inner'];
  if (OUTSIDE_BONE.has(id)) return ['bone'];
  // Ossicles, drum, and chorda are named on the dissection step that opens them.
  return [];
}

/** Placed landmarks that belong to the inner-ear crumb. The other placed points belong to the temporal bone. */
const INNER_LANDMARKS = new Set([
  'cochlea-basal',
  'cochlea-middle',
  'cochlea-apical',
  'geniculate-ganglion',
  'meatal-segment',
  'vestibule-center',
  'scc-lateral-arch',
  'scc-superior-arch',
  'scc-posterior-arch',
  'common-crus',
  'ampulla-lateral',
  'ampulla-superior',
  'ampulla-posterior',
  'iac',
  'arcuate-eminence',
]);

export function stagesForLandmark(id: string): ViewStage[] {
  return INNER_LANDMARKS.has(id) ? ['inner'] : ['bone'];
}

/** Landmarks and structures called out on a dissection step. */
export const STEP_LABELS: Record<string, readonly string[]> = {
  'cortical-mastoidectomy': ['mastoid-tip', 'tegmen', 'sigmoid-sinus', 'henle-spine', 'macewen-triangle', 'temporal-line'],
  antrum: ['incus-short-process', 'scc-lateral-arch', 'mastoid-antrum', 'tegmen', 'incus'],
  'identify-facial-nerve': ['second-genu', 'geniculate-ganglion', 'scc-lateral-arch', 'facial-nerve', 'chorda-tympani'],
  'posterior-tympanotomy': [
    'facial-recess',
    'round-window',
    'promontory',
    'stapes-footplate',
    'stapes-head',
    'chorda-tympani',
    'facial-nerve',
    'stapes',
  ],
  'transcanal-view': ['umbo', 'malleus-manubrium', 'malleus-lateral-process', 'pars-flaccida', 'tympanic-membrane', 'malleus'],
  'mcf-view': ['cochlea-basal', 'cochlea-middle', 'cochlea-apical', 'geniculate-ganglion', 'arcuate-eminence', 'scala-vestibuli', 'scala-tympani', 'facial-nerve'],
};

export function stepsForLabel(id: string): string[] {
  return Object.entries(STEP_LABELS)
    .filter(([, ids]) => ids.includes(id))
    .map(([step]) => step);
}

export const SURGICAL_STRUCTURES = new Set([
  'facial-nerve',
  'fn-mastoid',
  'fn-tympanic',
  'fn-second-genu',
  'chorda-tympani',
  'incus',
  'stapes',
  'scc-lateral',
  'scala-vestibuli',
  'scala-tympani',
  'malleus',
  'tympanic-membrane',
]);
