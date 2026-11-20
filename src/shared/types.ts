export const REVIEW_STATUSES = ['미검증', 'YS 검수 완료'] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export type Lang = 'ko' | 'en';

export type Localized = Record<Lang, string>;

export type Vec3 = [number, number, number];

export type Specimen = {
  id: string;
  name: string;
  model_version: string;
  licence: string;
  licence_url: string;
  citation: string;
  article_url: string;
  data_url: string;
  geometry: string;
  geometry_note: Localized;
};

export type LayerDef = {
  id: string;
  name: Localized;
  opacity: number;
  visible?: boolean;
};

export type StructureDef = {
  id: string;
  file: string;
  name: Localized;
  color: string;
  layer: string;
  status: ReviewStatus;
  content: string;
};

export type CoordinateAxis = {
  ko: string;
  en: string;
};

export type Manifest = {
  specimen: Specimen;
  model_version: string;
  viewer_offset_mm: Vec3;
  coordinate_system: {
    units: 'mm';
    x: CoordinateAxis;
    y: CoordinateAxis;
    z: CoordinateAxis;
    note: Localized;
  };
  layers: LayerDef[];
  structures: StructureDef[];
  missing_structures?: MissingStructure[];
};

export type SurgicalPoint = {
  id: string;
  title: Localized;
  body: Localized;
  position_mm: Vec3;
  source: string;
  status: ReviewStatus;
};

/** One reviewed paragraph. Anatomy, each function block, and each surgical point use this shape. */
export type ReviewedBlock = {
  text: Localized;
  source: string;
  status: ReviewStatus;
};

export type StructureContent = {
  id: string;
  model_version: string;
  /** Anatomy. Reviewers edit this without touching code. */
  info: {
    summary: Localized;
    source: string;
    status: ReviewStatus;
  };
  /** Physiology, dysfunction, and related tests. Each block has its own source and status. */
  function: {
    physiology: ReviewedBlock;
    injury: ReviewedBlock;
    tests: ReviewedBlock;
  };
  /**
   * Other structure ids that are functionally linked.
   * Optional. Tapping one highlights that structure in the viewer.
   */
  related?: string[];
  surgical_points: SurgicalPoint[];
};

export type CameraPose = {
  position: Vec3;
  target: Vec3;
  up?: Vec3;
  fov?: number;
};

export type ClippingPlane = {
  enabled: boolean;
  normal: Vec3;
  constant: number;
};

/** One ordered step in a dissection sequence. Drilling is not implemented. */
export type DissectionStep = {
  id: string;
  title: Localized;
  instructions: Localized;
  /** Structure ids the learner should identify at this step. */
  identify: string[];
  /** Structure ids that are at risk. Distances are not computed yet. */
  danger: string[];
  camera: CameraPose;
  clipping?: ClippingPlane;
};

export type DissectionSequence = {
  id: string;
  title: Localized;
  steps: DissectionStep[];
};

export type PresetFile = {
  model_version: string;
  note: Localized;
  sequences: DissectionSequence[];
};

export type VolumeMeta = {
  id: string;
  label: Localized;
  model_version: string;
  spacing_mm: Vec3;
  origin_mm: Vec3;
  /** Row-major 3×3. Column 0/1/2 are the directions of increasing i/j/k, in specimen mm. */
  direction: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  dims: Vec3;
  voxel_origin: 'center';
  /** When false, image row 0 is sampled at texture v = 0. */
  texture_flip_y: boolean;
  index_digits: number;
  file_extension: string;
  planes: {
    axial: PlaneDef;
    coronal: PlaneDef;
    sagittal: PlaneDef;
  };
};

export type PlaneDef = {
  /** Constant axis: 0 = i, 1 = j, 2 = k. */
  axis: 0 | 1 | 2;
  folder: string;
  /** Image columns increase along this axis. */
  col_axis: 0 | 1 | 2;
  /** Image rows run along this axis. */
  row_axis: 0 | 1 | 2;
  /** File row 0 is the high end of row_axis (anterior or superior in the ZETA stacks). */
  row_0_is_max: boolean;
  initial_index?: number;
};

export type MissingStructure = {
  name: string;
  note: string;
};

export type SchemaIssue = { path: string; message: string };
