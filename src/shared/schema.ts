import { REVIEW_STATUSES, type ReviewStatus, type SchemaIssue } from './types';

const HEX = /^#[0-9a-fA-F]{6}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function vec3(value: unknown, path: string, issues: SchemaIssue[]): value is [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(isNum)) {
    issues.push({ path, message: 'expected [number, number, number]' });
    return false;
  }
  return true;
}

function localized(value: unknown, path: string, issues: SchemaIssue[]): boolean {
  if (!isObject(value) || typeof value.ko !== 'string' || value.ko.trim() === '' || typeof value.en !== 'string') {
    issues.push({ path, message: 'expected { ko: non-empty string, en: string }' });
    return false;
  }
  return true;
}

function status(value: unknown, path: string, issues: SchemaIssue[]): value is ReviewStatus {
  if (typeof value !== 'string' || !REVIEW_STATUSES.includes(value as ReviewStatus)) {
    issues.push({ path, message: `status must be one of ${REVIEW_STATUSES.join(' | ')}` });
    return false;
  }
  return true;
}

function stringField(obj: Record<string, unknown>, key: string, path: string, issues: SchemaIssue[]): boolean {
  if (typeof obj[key] !== 'string' || (obj[key] as string).trim() === '') {
    issues.push({ path: path ? `${path}.${key}` : key, message: 'expected non-empty string' });
    return false;
  }
  return true;
}

export function validateManifest(data: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (!isObject(data)) return [{ path: '', message: 'manifest must be an object' }];

  if (!isObject(data.specimen)) {
    issues.push({ path: 'specimen', message: 'expected object' });
  } else {
    for (const key of ['id', 'name', 'model_version', 'licence', 'licence_url', 'citation', 'article_url', 'data_url', 'geometry']) {
      stringField(data.specimen, key, 'specimen', issues);
    }
    localized(data.specimen.geometry_note, 'specimen.geometry_note', issues);
  }

  stringField(data, 'model_version', '', issues);
  if (isObject(data.specimen) && typeof data.specimen.model_version === 'string' && typeof data.model_version === 'string') {
    if (data.specimen.model_version !== data.model_version) {
      issues.push({ path: 'model_version', message: 'must match specimen.model_version' });
    }
  }

  vec3(data.viewer_offset_mm, 'viewer_offset_mm', issues);

  if (!isObject(data.coordinate_system)) {
    issues.push({ path: 'coordinate_system', message: 'expected object' });
  } else {
    if (data.coordinate_system.units !== 'mm') {
      issues.push({ path: 'coordinate_system.units', message: 'units must be mm' });
    }
    localized(data.coordinate_system.x, 'coordinate_system.x', issues);
    localized(data.coordinate_system.y, 'coordinate_system.y', issues);
    localized(data.coordinate_system.z, 'coordinate_system.z', issues);
    localized(data.coordinate_system.note, 'coordinate_system.note', issues);
  }

  const layerIds = new Set<string>();
  if (!Array.isArray(data.layers) || data.layers.length === 0) {
    issues.push({ path: 'layers', message: 'expected non-empty array' });
  } else {
    data.layers.forEach((layer, i) => {
      const path = `layers[${i}]`;
      if (!isObject(layer)) {
        issues.push({ path, message: 'expected object' });
        return;
      }
      if (typeof layer.id !== 'string' || layer.id.trim() === '') {
        issues.push({ path: `${path}.id`, message: 'expected non-empty string' });
      } else if (layerIds.has(layer.id)) {
        issues.push({ path: `${path}.id`, message: 'duplicate layer id' });
      } else {
        layerIds.add(layer.id);
      }
      localized(layer.name, `${path}.name`, issues);
      if (!isNum(layer.opacity) || layer.opacity < 0 || layer.opacity > 1) {
        issues.push({ path: `${path}.opacity`, message: 'opacity must be a number from 0 to 1' });
      }
    });
  }

  const structureIds = new Set<string>();
  if (!Array.isArray(data.structures) || data.structures.length === 0) {
    issues.push({ path: 'structures', message: 'expected non-empty array' });
  } else {
    data.structures.forEach((structure, i) => {
      const path = `structures[${i}]`;
      if (!isObject(structure)) {
        issues.push({ path, message: 'expected object' });
        return;
      }
      if ('scale' in structure || 'scale_mm' in structure) {
        issues.push({ path, message: 'structures must not declare a scale; meshes stay in real millimetres' });
      }
      if (typeof structure.id !== 'string' || structure.id.trim() === '') {
        issues.push({ path: `${path}.id`, message: 'expected non-empty string' });
      } else if (structureIds.has(structure.id)) {
        issues.push({ path: `${path}.id`, message: 'duplicate structure id' });
      } else {
        structureIds.add(structure.id);
      }
      if (typeof structure.file !== 'string' || !structure.file.endsWith('.glb')) {
        issues.push({ path: `${path}.file`, message: 'expected a .glb path' });
      }
      localized(structure.name, `${path}.name`, issues);
      if (typeof structure.color !== 'string' || !HEX.test(structure.color)) {
        issues.push({ path: `${path}.color`, message: 'expected #rrggbb' });
      }
      if (typeof structure.layer !== 'string' || !layerIds.has(structure.layer)) {
        issues.push({ path: `${path}.layer`, message: 'layer must reference layers[].id' });
      }
      status(structure.status, `${path}.status`, issues);
      if (typeof structure.content !== 'string' || !structure.content.endsWith('.json')) {
        issues.push({ path: `${path}.content`, message: 'expected a .json content path' });
      }
    });
  }

  return issues;
}

function reviewedBlock(value: unknown, path: string, issues: SchemaIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path, message: 'expected object with text, source, and status' });
    return;
  }
  localized(value.text, `${path}.text`, issues);
  stringField(value, 'source', path, issues);
  status(value.status, `${path}.status`, issues);
}

export function validateContent(data: unknown, expectedId?: string, knownIds?: ReadonlySet<string>): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (!isObject(data)) return [{ path: '', message: 'content must be an object' }];
  stringField(data, 'id', '', issues);
  stringField(data, 'model_version', '', issues);
  if (expectedId && data.id !== expectedId) {
    issues.push({ path: 'id', message: `content id must match structure id ${expectedId}` });
  }
  if (!isObject(data.info)) {
    issues.push({ path: 'info', message: 'expected object' });
  } else {
    localized(data.info.summary, 'info.summary', issues);
    stringField(data.info, 'source', 'info', issues);
    status(data.info.status, 'info.status', issues);
  }
  if (!isObject(data.function)) {
    issues.push({ path: 'function', message: 'expected object with physiology, injury, and tests' });
  } else {
    reviewedBlock(data.function.physiology, 'function.physiology', issues);
    reviewedBlock(data.function.injury, 'function.injury', issues);
    reviewedBlock(data.function.tests, 'function.tests', issues);
  }
  if (data.related !== undefined) {
    if (!Array.isArray(data.related)) {
      issues.push({ path: 'related', message: 'expected an array of structure ids' });
    } else {
      const seen = new Set<string>();
      data.related.forEach((id, index) => {
        const path = `related[${index}]`;
        if (typeof id !== 'string' || id.trim() === '') {
          issues.push({ path, message: 'expected a structure id' });
          return;
        }
        if (expectedId && id === expectedId) {
          issues.push({ path, message: 'a structure cannot list itself in related' });
        }
        if (seen.has(id)) issues.push({ path, message: 'duplicate related id' });
        seen.add(id);
        if (knownIds && !knownIds.has(id)) {
          issues.push({ path, message: `unknown structure id ${id}` });
        }
      });
    }
  }
  if (!Array.isArray(data.surgical_points)) {
    issues.push({ path: 'surgical_points', message: 'expected array' });
  } else {
    data.surgical_points.forEach((point, i) => {
      const path = `surgical_points[${i}]`;
      if (!isObject(point)) {
        issues.push({ path, message: 'expected object' });
        return;
      }
      stringField(point, 'id', path, issues);
      localized(point.title, `${path}.title`, issues);
      localized(point.body, `${path}.body`, issues);
      vec3(point.position_mm, `${path}.position_mm`, issues);
      stringField(point, 'source', path, issues);
      status(point.status, `${path}.status`, issues);
    });
  }
  return issues;
}

function idList(value: unknown, path: string, issues: SchemaIssue[], knownIds?: ReadonlySet<string>): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'expected an array of structure ids' });
    return;
  }
  const seen = new Set<string>();
  value.forEach((id, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof id !== 'string' || id.trim() === '') {
      issues.push({ path: itemPath, message: 'expected a structure id' });
      return;
    }
    if (seen.has(id)) issues.push({ path: itemPath, message: 'duplicate structure id' });
    seen.add(id);
    if (knownIds && !knownIds.has(id)) issues.push({ path: itemPath, message: `unknown structure id ${id}` });
  });
}

function cameraFields(camera: unknown, path: string, issues: SchemaIssue[]): void {
  if (!isObject(camera)) {
    issues.push({ path, message: 'expected object' });
    return;
  }
  vec3(camera.position, `${path}.position`, issues);
  vec3(camera.target, `${path}.target`, issues);
  if (camera.up !== undefined) vec3(camera.up, `${path}.up`, issues);
  if (camera.fov !== undefined && (!isNum(camera.fov) || camera.fov <= 0 || camera.fov >= 180)) {
    issues.push({ path: `${path}.fov`, message: 'fov must be between 0 and 180' });
  }
}

function clippingFields(clipping: unknown, path: string, issues: SchemaIssue[]): void {
  if (!isObject(clipping)) {
    issues.push({ path, message: 'expected object' });
    return;
  }
  if (typeof clipping.enabled !== 'boolean') {
    issues.push({ path: `${path}.enabled`, message: 'expected boolean' });
  }
  vec3(clipping.normal, `${path}.normal`, issues);
  if (!isNum(clipping.constant)) {
    issues.push({ path: `${path}.constant`, message: 'expected number (mm, specimen space)' });
  }
}

export function validatePresets(data: unknown, knownIds?: ReadonlySet<string>): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (!isObject(data)) return [{ path: '', message: 'presets must be an object' }];
  stringField(data, 'model_version', '', issues);
  localized(data.note, 'note', issues);
  if (!Array.isArray(data.sequences) || data.sequences.length === 0) {
    issues.push({ path: 'sequences', message: 'expected a non-empty ordered list of sequences' });
    return issues;
  }
  const sequenceIds = new Set<string>();
  const stepIds = new Set<string>();
  data.sequences.forEach((sequence, sequenceIndex) => {
    const path = `sequences[${sequenceIndex}]`;
    if (!isObject(sequence)) {
      issues.push({ path, message: 'expected object' });
      return;
    }
    if (typeof sequence.id !== 'string' || sequenceIds.has(sequence.id)) {
      issues.push({ path: `${path}.id`, message: 'expected a unique id' });
    } else {
      sequenceIds.add(sequence.id);
    }
    localized(sequence.title, `${path}.title`, issues);
    if (!Array.isArray(sequence.steps) || sequence.steps.length === 0) {
      issues.push({ path: `${path}.steps`, message: 'expected a non-empty ordered list of steps' });
      return;
    }
    sequence.steps.forEach((step, stepIndex) => {
      const stepPath = `${path}.steps[${stepIndex}]`;
      if (!isObject(step)) {
        issues.push({ path: stepPath, message: 'expected object' });
        return;
      }
      if (typeof step.id !== 'string' || stepIds.has(step.id)) {
        issues.push({ path: `${stepPath}.id`, message: 'expected a unique id' });
      } else {
        stepIds.add(step.id);
      }
      localized(step.title, `${stepPath}.title`, issues);
      localized(step.instructions, `${stepPath}.instructions`, issues);
      idList(step.identify, `${stepPath}.identify`, issues, knownIds);
      idList(step.danger, `${stepPath}.danger`, issues, knownIds);
      cameraFields(step.camera, `${stepPath}.camera`, issues);
      if (step.clipping !== undefined) clippingFields(step.clipping, `${stepPath}.clipping`, issues);
    });
  });
  return issues;
}

export function validateVolume(data: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (!isObject(data)) return [{ path: '', message: 'volume must be an object' }];
  stringField(data, 'id', '', issues);
  localized(data.label, 'label', issues);
  stringField(data, 'model_version', '', issues);
  vec3(data.spacing_mm, 'spacing_mm', issues);
  vec3(data.origin_mm, 'origin_mm', issues);
  vec3(data.dims, 'dims', issues);
  if (Array.isArray(data.spacing_mm) && data.spacing_mm.some((n) => !isNum(n) || n <= 0)) {
    issues.push({ path: 'spacing_mm', message: 'spacing must be positive millimetres' });
  }
  if (Array.isArray(data.dims)) {
    data.dims.forEach((n, i) => {
      if (!isNum(n) || n < 1 || !Number.isInteger(n)) {
        issues.push({ path: `dims[${i}]`, message: 'expected positive integer' });
      }
    });
  }
  if (!Array.isArray(data.direction) || data.direction.length !== 9 || !data.direction.every(isNum)) {
    issues.push({ path: 'direction', message: 'expected 9 finite numbers (row-major 3×3)' });
  }
  if (data.voxel_origin !== 'center') {
    issues.push({ path: 'voxel_origin', message: 'only "center" is supported (origin is the center of voxel 0,0,0)' });
  }
  if (typeof data.texture_flip_y !== 'boolean') {
    issues.push({ path: 'texture_flip_y', message: 'expected boolean' });
  }
  if (!isNum(data.index_digits) || data.index_digits < 1 || !Number.isInteger(data.index_digits)) {
    issues.push({ path: 'index_digits', message: 'expected a positive integer' });
  }
  if (typeof data.file_extension !== 'string' || !/^[a-z0-9]+$/.test(data.file_extension)) {
    issues.push({ path: 'file_extension', message: 'expected a file extension such as webp' });
  }
  const planes = data.planes;
  if (!isObject(planes)) {
    issues.push({ path: 'planes', message: 'expected object' });
  } else {
    (['axial', 'coronal', 'sagittal'] as const).forEach((name) => {
      const plane = planes[name];
      const path = `planes.${name}`;
      if (!isObject(plane)) {
        issues.push({ path, message: 'expected object' });
        return;
      }
      for (const key of ['axis', 'col_axis', 'row_axis'] as const) {
        if (plane[key] !== 0 && plane[key] !== 1 && plane[key] !== 2) {
          issues.push({ path: `${path}.${key}`, message: 'axis must be 0 (i), 1 (j), or 2 (k)' });
        }
      }
      if (plane.axis === plane.col_axis || plane.axis === plane.row_axis || plane.col_axis === plane.row_axis) {
        issues.push({ path, message: 'axis, col_axis, and row_axis must be three different axes' });
      }
      if (typeof plane.row_0_is_max !== 'boolean') {
        issues.push({ path: `${path}.row_0_is_max`, message: 'expected boolean' });
      }
      if (typeof plane.folder !== 'string' || plane.folder.trim() === '') {
        issues.push({ path: `${path}.folder`, message: 'expected folder path' });
      }
      if (plane.initial_index !== undefined && (!isNum(plane.initial_index) || plane.initial_index < 0)) {
        issues.push({ path: `${path}.initial_index`, message: 'expected a non-negative index' });
      }
    });
  }
  return issues;
}

export function formatIssues(issues: SchemaIssue[]): string {
  return issues.map((issue) => `${issue.path || '(root)'}: ${issue.message}`).join('\n');
}
