/** Shared VOR records. The simulator reads these; it does not own the numbers. */

export type ReviewFlag = 'unverified' | 'verified';

export type Vec3 = [number, number, number];

export type CitedNumber = {
  value: number;
  unit: string;
  source: string;
  note?: string;
  reviewStatus: ReviewFlag;
};

export type LocalizedNote = { en: string; ko: string };

export type CanalRecord = {
  id: string;
  side: 'right' | 'left';
  plane: 'horizontal' | 'anterior' | 'posterior';
  /** Unit normal. Head angular velocity (Reid, deg/s) dotted with this excites the canal. */
  excitatoryNormal: Vec3;
  source: string;
  reviewStatus: ReviewFlag;
  note?: LocalizedNote;
};

export type CanalFile = {
  frame: {
    id: 'reid';
    x: string;
    y: string;
    z: string;
    source: string;
    reviewStatus: ReviewFlag;
  };
  canals: CanalRecord[];
};

export type NodeKind = 'canal' | 'nerve' | 'nucleus' | 'tract' | 'muscle' | 'eye' | 'landmark';

export type GraphNode = {
  id: string;
  kind: NodeKind;
  nameEn: string;
  nameKo: string;
  side: 'right' | 'left' | 'midline';
  reviewStatus: ReviewFlag;
  source: string;
  note?: LocalizedNote;
  /**
   * Reid angular-velocity axis (deg/s) produced by a positive muscle activation.
   * Muscles only. Same frame as `excitatoryNormal`.
   */
  axisReid?: Vec3;
};

export type GraphEdge = {
  id: string;
  from: string;
  to: string;
  /** +1 excitatory, -1 inhibitory. */
  sign: 1 | -1;
  /**
   * 0 means the edge is drawn and used for highlight only.
   * The drive graph (nonzero weights) is acyclic.
   */
  weight: number;
  source: string;
  reviewStatus: ReviewFlag;
  note?: LocalizedNote;
};

export type GraphFile = {
  modelVersion: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type ParamsFile = {
  modelVersion: string;
  baselineSpikesPerSec: CitedNumber;
  afferentGainSpikesPerDegPerSec: CitedNumber;
  cupulaTimeConstantSec: CitedNumber;
  velocityStorageSec: CitedNumber;
  vorGain: CitedNumber;
  plantScale: CitedNumber;
  fastPhaseThresholdDeg: CitedNumber;
  fastPhaseSpeedDegPerSec: CitedNumber;
  fastPhaseStopDeg: CitedNumber;
};

/** Scene millimetres: +X patient's right, +Y superior, +Z posterior. Schematic. */
export type LayoutFile = {
  frame: string;
  source: string;
  reviewStatus: ReviewFlag;
  note: LocalizedNote;
  fixed: Record<string, Vec3>;
  spread: Record<string, Vec3>;
  anatomic: Record<string, Vec3>;
};

export type VorBundle = {
  canals: CanalFile;
  graph: GraphFile;
  params: ParamsFile;
  layout: LayoutFile;
};
