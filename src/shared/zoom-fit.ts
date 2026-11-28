import type { ViewStage } from './stage-frame';
import type { Vec3 } from './types';

/** Camera-to-target limits, in millimetres, switched on when a stage is fitted. */
export const STAGE_LIMITS: Record<ViewStage, { min: number; max: number }> = {
  body: { min: 300, max: 1500 },
  ear: { min: 40, max: 500 },
  bone: { min: 15, max: 400 },
  inner: { min: 7, max: 150 },
};

/**
 * Whole-body shells. Their bounding radius is the entire head, so the stage
 * minimum is what keeps the camera in front of the skin.
 */
const ZOOM_SHELL = new Set(['skin', 'upper-body', 'skull-layer', 'ear-hotspot']);

/** Size used for the stop distance. Shells defer to the stage minimum. */
export function zoomStructureSize(id: string, radiusMm: number): number {
  if (ZOOM_SHELL.has(id)) return 0;
  if (!Number.isFinite(radiusMm) || radiusMm <= 0) return 0;
  return radiusMm;
}

/** Closest the camera may come to the anchor. `structureSizeMm` is the bounding-sphere radius. */
export function stopDistanceMm(structureSizeMm: number, stageMinMm: number): number {
  const size = Math.max(structureSizeMm, 0);
  const stageMin = Math.max(stageMinMm, 0);
  return Math.max(size * 0.6, stageMin, 0.5);
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function mul(a: Vec3, scale: number): Vec3 {
  return [a[0] * scale, a[1] * scale, a[2] * scale];
}

function len(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm(a: Vec3): Vec3 {
  const scale = len(a) || 1;
  return mul(a, 1 / scale);
}

export type ZoomPose = { camera: Vec3; target: Vec3; distance: number };

/**
 * Move the camera and the orbit target toward `anchor` by the same scale.
 * The anchor stays on the same camera ray, so the point under the finger
 * stays put. A miss (`anchor === null`) dollies along the current view and
 * leaves the target where it is.
 * `scale` < 1 zooms in. The result stays inside the stage distance limits
 * and at least `stopDistance` from the anchor.
 */
export function zoomAboutAnchor(input: {
  camera: Vec3;
  target: Vec3;
  anchor: Vec3 | null;
  scale: number;
  minDistance: number;
  maxDistance: number;
  stopDistance: number;
}): ZoomPose {
  const minD = Math.max(input.minDistance, 0.5);
  const maxD = Math.max(input.maxDistance, minD);
  const stop = Math.max(input.stopDistance, 0.5);
  const requested = Number.isFinite(input.scale) && input.scale > 0 ? input.scale : 1;
  const offset = sub(input.camera, input.target);
  const current = Math.max(len(offset), 0.5);

  if (!input.anchor) {
    const desired = Math.min(maxD, Math.max(minD, current * requested));
    const camera = add(input.target, mul(norm(offset), desired));
    return { camera, target: [input.target[0], input.target[1], input.target[2]], distance: desired };
  }

  const fromAnchor = sub(input.camera, input.anchor);
  const anchorDist = Math.max(len(fromAnchor), 0.5);
  const minS = minD / current;
  const maxS = maxD / current;
  const stopS = stop / anchorDist;
  let s = requested;
  if (s < Math.max(minS, stopS)) s = Math.max(minS, stopS);
  if (s > maxS) s = maxS;
  // A zoom-in may stop early. It must not jump farther than the current distance
  // when the new anchor happens to sit against the camera.
  if (requested < 1 && s > 1) s = 1;
  if (requested > 1 && s < 1) s = 1;

  const camera = add(input.anchor, mul(fromAnchor, s));
  const target = add(input.anchor, mul(sub(input.target, input.anchor), s));
  return { camera, target, distance: len(sub(camera, target)) };
}

/** Pan so `anchor` becomes the orbit centre without changing distance or direction. */
export function orbitAbout(camera: Vec3, target: Vec3, anchor: Vec3): { camera: Vec3; target: Vec3 } {
  return { camera: add(anchor, sub(camera, target)), target: [anchor[0], anchor[1], anchor[2]] };
}

/**
 * Keep the camera outside the last surface point while it rotates.
 * The orbit centre stays on that point. A swing that faces away from the
 * outward direction, or that comes closer than the stop, is put back.
 */
export function holdOrbit(input: {
  camera: Vec3;
  target: Vec3;
  anchor: Vec3;
  outward: Vec3;
  minDistance: number;
  stopDistance: number;
}): { camera: Vec3; target: Vec3; held: boolean } {
  const minKeep = Math.max(input.minDistance, input.stopDistance, 0.5);
  const offset = sub(input.camera, input.anchor);
  const dist = len(offset);
  const dir = dist > 1e-4 ? mul(offset, 1 / dist) : norm(input.outward);
  const outward = len(input.outward) > 1e-4 ? norm(input.outward) : dir;
  const facing = dir[0] * outward[0] + dir[1] * outward[1] + dir[2] * outward[2];
  const tooClose = dist < minKeep - 0.05;
  const swungThrough = facing < 0.34;
  if (!tooClose && !swungThrough) {
    return {
      camera: [input.camera[0], input.camera[1], input.camera[2]],
      target: [input.anchor[0], input.anchor[1], input.anchor[2]],
      held: false,
    };
  }
  const keep = tooClose ? minKeep : Math.max(dist, minKeep);
  const aim = swungThrough ? outward : dir;
  return {
    camera: add(input.anchor, mul(aim, keep)),
    target: [input.anchor[0], input.anchor[1], input.anchor[2]],
    held: true,
  };
}

/**
 * Lateral offset of `point` over its depth along the view. Equal values mean
 * the point stays on the same pixel.
 */
export function viewTangent(camera: Vec3, target: Vec3, point: Vec3): Vec3 {
  const look = norm(sub(target, camera));
  const rel = sub(point, camera);
  const depth = dot(rel, look) || 1;
  return mul(sub(rel, mul(look, depth)), 1 / depth);
}

export type VisibleRect = { x: number; y: number; width: number; height: number };

/**
 * `setViewOffset` arguments that put the look-at point at the centre of
 * `visible` inside a canvas of `canvasWidth` × `canvasHeight`.
 */
export function viewOffsetFor(
  canvasWidth: number,
  canvasHeight: number,
  visible: VisibleRect,
): { fullWidth: number; fullHeight: number; x: number; y: number; width: number; height: number } {
  const cx = visible.x + visible.width / 2;
  const cy = visible.y + visible.height / 2;
  return {
    fullWidth: canvasWidth,
    fullHeight: canvasHeight,
    x: canvasWidth / 2 - cx,
    y: canvasHeight / 2 - cy,
    width: canvasWidth,
    height: canvasHeight,
  };
}

/** Vertical field of view, in degrees, subtended by `visibleHeight` of the canvas. */
export function visibleFovDeg(fovDeg: number, canvasHeight: number, visibleHeight: number): number {
  const tanHalf = Math.tan((fovDeg * Math.PI) / 360);
  const frac = Math.min(1, Math.max(visibleHeight, 1) / Math.max(canvasHeight, 1));
  return (Math.atan(tanHalf * frac) * 360) / Math.PI;
}

/** Distance that fits a sphere of `radiusMm` inside the unobscured rectangle. */
export function fitDistanceMm(options: {
  radiusMm: number;
  fovDeg: number;
  canvasWidth: number;
  canvasHeight: number;
  visibleWidth: number;
  visibleHeight: number;
  margin?: number;
}): number {
  const margin = options.margin ?? 1.5;
  const radius = Math.max(options.radiusMm, 0.8);
  const tanHalf = Math.tan((options.fovDeg * Math.PI) / 360);
  const canvasH = Math.max(options.canvasHeight, 1);
  const canvasW = Math.max(options.canvasWidth, 1);
  const visH = Math.max(1, Math.min(options.visibleHeight, canvasH));
  const visW = Math.max(1, Math.min(options.visibleWidth, canvasW));
  const tanV = Math.max(tanHalf * (visH / canvasH), 1e-4);
  const tanH = Math.max(tanHalf * (visW / canvasH), 1e-4);
  return Math.max((radius * margin) / tanV, (radius * margin) / tanH);
}

/** Scala pieces that together are the cochlea. There is no single cochlea mesh. */
export const COCHLEA_PARTS = [
  'scala-vestibuli',
  'scala-tympani',
  'scala-vestibuli-basal',
  'scala-vestibuli-middle',
  'scala-vestibuli-apical',
  'scala-tympani-basal',
  'scala-tympani-middle',
  'scala-tympani-apical',
] as const;

/** Picker id. Cochlear scalae share one chip; the vestibule stays separate. */
/** List row that should look selected. A cochlea fit keeps the Cochlea row, not one scala. */
export function listSelectionId(selectedId: string | null, titleEn?: string | null): string | null {
  if (!selectedId) return null;
  if (groupPickId(selectedId) === 'cochlea' && titleEn === 'Cochlea') return 'cochlea';
  return selectedId;
}

export function groupPickId(id: string): string {
  if (id === 'cochlea' || id.startsWith('scala-')) return 'cochlea';
  if (id === 'vestibule-center') return 'vestibule';
  return id;
}

export type LabelAction =
  | { kind: 'structure'; structureId: string }
  | { kind: 'cochlea'; structureId: 'scala-vestibuli' }
  | { kind: 'iac'; structureId: 'cochleovestibular-nerve' };

/** Where a study-label id should select and how it should be framed. */
export function labelAction(id: string): LabelAction {
  if (id === 'cochlea') return { kind: 'cochlea', structureId: 'scala-vestibuli' };
  if (id === 'iac') return { kind: 'iac', structureId: 'cochleovestibular-nerve' };
  if (id === 'vestibule' || id === 'vestibule-center') return { kind: 'structure', structureId: 'vestibule' };
  return { kind: 'structure', structureId: id };
}
