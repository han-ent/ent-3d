import type { Vec3 } from './types';

/**
 * ZETA mesh axes, checked against the specimen:
 * +X anterior, +Y inferior, +Z medial (right ear).
 */
export const ANATOMICAL_FRAME = {
  anterior: [1, 0, 0] as Vec3,
  posterior: [-1, 0, 0] as Vec3,
  inferior: [0, 1, 0] as Vec3,
  superior: [0, -1, 0] as Vec3,
  medial: [0, 0, 1] as Vec3,
  lateral: [0, 0, -1] as Vec3,
};

export const GIZMO_AXES: { id: string; dir: Vec3; text: string }[] = [
  { id: 'ant', dir: ANATOMICAL_FRAME.anterior, text: 'Ant' },
  { id: 'post', dir: ANATOMICAL_FRAME.posterior, text: 'Post' },
  { id: 'sup', dir: ANATOMICAL_FRAME.superior, text: 'Sup' },
  { id: 'inf', dir: ANATOMICAL_FRAME.inferior, text: 'Inf' },
  { id: 'lat', dir: ANATOMICAL_FRAME.lateral, text: 'Lat' },
  { id: 'med', dir: ANATOMICAL_FRAME.medial, text: 'Med' },
];

export type StackPlane = 'axial' | 'coronal' | 'sagittal';

/**
 * The published folders keep their file names.
 * Constant Z (folder axial) is an anatomical sagittal plane,
 * constant Y (folder coronal) is anatomical axial,
 * constant X (folder sagittal) is anatomical coronal.
 */
export function anatomicalPlaneName(folder: StackPlane): 'axial' | 'coronal' | 'sagittal' {
  if (folder === 'axial') return 'sagittal';
  if (folder === 'coronal') return 'axial';
  return 'coronal';
}

export type EdgeLabels = { left: string; top: string; right: string; bottom: string };

/**
 * Edge labels for the 2D canvas as it is drawn today:
 * column 0 is the low end of the column axis, row 0 (top) is the high end of the row axis.
 */
/** Edge letters of the published file, before the radiological display turn. */
export function ctEdgeLabels(folder: StackPlane): EdgeLabels {
  if (folder === 'axial') return { left: 'Post', top: 'Inf', right: 'Ant', bottom: 'Sup' };
  if (folder === 'coronal') return { left: 'Post', top: 'Med', right: 'Ant', bottom: 'Lat' };
  return { left: 'Sup', top: 'Med', right: 'Inf', bottom: 'Lat' };
}

export type DisplayOrient = {
  /** Clockwise quarter-turns applied to the published image. */
  turnsCW: 0 | 1 | 2 | 3;
  flipX: boolean;
  flipY: boolean;
};

/**
 * Radiological display for this right ear.
 * Axial: anterior at the top, the patient's right (lateral) on the viewer's left.
 * Coronal: superior at the top, the patient's right on the viewer's left.
 * Sagittal: superior at the top, posterior on the viewer's left.
 */
export function ctDisplayOrient(folder: StackPlane): DisplayOrient {
  const anatomical = anatomicalPlaneName(folder);
  if (anatomical === 'axial') return { turnsCW: 3, flipX: true, flipY: false };
  if (anatomical === 'coronal') return { turnsCW: 1, flipX: false, flipY: false };
  return { turnsCW: 0, flipX: false, flipY: true };
}

export function displayedEdgeLabels(folder: StackPlane): EdgeLabels {
  const anatomical = anatomicalPlaneName(folder);
  if (anatomical === 'axial') return { left: 'Lat', top: 'Ant', right: 'Med', bottom: 'Post' };
  if (anatomical === 'coronal') return { left: 'Lat', top: 'Sup', right: 'Med', bottom: 'Inf' };
  return { left: 'Post', top: 'Sup', right: 'Ant', bottom: 'Inf' };
}

/** Raw image fraction, origin at the top left, into the displayed image. */
export function mapRawToDisplay(orient: DisplayOrient, u: number, v: number): { u: number; v: number } {
  let x = u;
  let y = v;
  for (let turn = 0; turn < orient.turnsCW; turn += 1) {
    const nextX = 1 - y;
    const nextY = x;
    x = nextX;
    y = nextY;
  }
  if (orient.flipX) x = 1 - x;
  if (orient.flipY) y = 1 - y;
  return { u: x, v: y };
}

export function mapDisplayToRaw(orient: DisplayOrient, u: number, v: number): { u: number; v: number } {
  let x = u;
  let y = v;
  if (orient.flipY) y = 1 - y;
  if (orient.flipX) x = 1 - x;
  const turns = (4 - orient.turnsCW) % 4;
  for (let turn = 0; turn < turns; turn += 1) {
    const nextX = 1 - y;
    const nextY = x;
    x = nextX;
    y = nextY;
  }
  return { u: x, v: y };
}

export function displayedSize(orient: DisplayOrient, width: number, height: number): { width: number; height: number } {
  if (orient.turnsCW % 2 === 1) return { width: height, height: width };
  return { width, height };
}
