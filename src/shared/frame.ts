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
export function ctEdgeLabels(folder: StackPlane): EdgeLabels {
  if (folder === 'axial') return { left: 'Post', top: 'Inf', right: 'Ant', bottom: 'Sup' };
  if (folder === 'coronal') return { left: 'Post', top: 'Med', right: 'Ant', bottom: 'Lat' };
  return { left: 'Sup', top: 'Med', right: 'Inf', bottom: 'Lat' };
}
