import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { ContourSource } from '../ct-slice';
import { displayOpacity, chooseTap, isEnvelope, isNavShell, rankTapChoices, TAP_SCREEN_RADIUS_PX, touchSampleOffsets, type PickCandidate } from '../picking';
import { publicUrl } from '../paths';
import type { SlicePose } from '../ct';
import { chooseScaleMm, worldClippingPlane } from '../measurement';
import type { DissectionStep, Vec3 } from '../types';
import { GIZMO_AXES } from '../frame';
import { chooseStudyLabels, columnPlacements, estimateLabelSize, focusPartList, placeLabels, relayoutOnTweenEnd, thinForPhone, usesPhoneLabelLayout, type Placement, type StudyLabel } from '../labels';
import type { ViewStage } from '../stage-frame';
import { distanceForAspect, INNER_CORE, placeAlong } from '../stage-frame';
import { labelAnchorPoint } from '../surface-anchor';
import { DEFAULT_CAMERA, DEFAULT_FOV, framingSpanMm, SELECTION_SPAN_MM } from '../view-pose';
import {
  COCHLEA_PARTS,
  STAGE_LIMITS,
  fitDistanceMm,
  holdOrbit,
  orbitAbout,
  stopDistanceMm,
  viewOffsetFor,
  zoomAboutAnchor,
  zoomStructureSize,
  type VisibleRect,
} from '../zoom-fit';
import { choosePixelRatio, coveredBySphere } from './budget';
import { easeOrbitOffset, MAX_DRAG_STEP_RAD, MAX_HOLD_STEP_RAD } from '../orbit-guard';
import {
  ATLAS_BACKGROUND,
  MODEL_BACKGROUND,
  atlasDetail,
  createAtlasMaterial,
  createHullMaterial,
  cutScaleFor,
  illustrationRamp,
  outlinesAllowed,
  paintAtlas,
} from './netter-material';

export type PickHit = {
  structureId: string;
  pointMm: Vec3;
  kind: 'structure' | 'ct';
  /** Other structures under the same finger, closest first, including this one. */
  overlaps?: { structureId: string; pointMm: Vec3 }[];
};

type StructureRecord = {
  id: string;
  layer: string;
  object: THREE.Object3D;
  materials: THREE.Material[];
  meshes: THREE.Mesh[];
  outlines: THREE.Mesh[];
  hulls: THREE.Mesh[];
  opacity: number;
  envelope: boolean;
  size: number;
  color: string;
  label: string;
  parentId: string | null;
  aggregate: boolean;
  side: THREE.Side;
  ends?: [THREE.Vector3, THREE.Vector3];
};

export type RenderStyle = 'atlas' | 'model';

export type RegistrationPair = {
  id: string;
  zetaMm: Vec3;
  skullMm: Vec3;
};

type PlaneRecord = {
  mesh: THREE.Mesh;
  texture: THREE.Texture;
  material: THREE.MeshBasicMaterial;
};

type Gathered = PickCandidate & { point: THREE.Vector3; kind: 'structure' | 'ct' };

type PresetVisibility = {
  hidden: Set<string>;
  ghosted: Set<string>;
  visible: Set<string> | null;
};

type Tween = {
  fromP: THREE.Vector3;
  toP: THREE.Vector3;
  fromT: THREE.Vector3;
  toT: THREE.Vector3;
  fromU: THREE.Vector3;
  toU: THREE.Vector3;
  fromF: number;
  toF: number;
  start: number;
};

const SVG_NS = ['http', '://www.w3.org/2000/svg'].join('');
const TWEEN_MS = 500;
const OUTLINE = '#8C2F1B';
const DIM_GRAY = '#D5D3CE';
const INTRO_LABELS = ['malleus', 'incus', 'stapes', 'facial-nerve', 'scala-vestibuli'];

function isMesh(obj: THREE.Object3D): obj is THREE.Mesh {
  return (obj as THREE.Mesh).isMesh === true;
}

function isShown(obj: THREE.Object3D): boolean {
  let node: THREE.Object3D | null = obj;
  while (node) {
    if (!node.visible) return false;
    node = node.parent;
  }
  return true;
}

function ease(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

/**
 * Shared millimetre viewer.
 * Specimen meshes are parented under a group that may be translated by
 * `viewer_offset_mm`. Their scale is never changed.
 */
export class EntViewer {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private world = new THREE.Group();
  private structures = new THREE.Group();
  private measures = new THREE.Group();
  private loader = new GLTFLoader();
  private draco = new DRACOLoader();
  private records = new Map<string, StructureRecord>();
  private pickables: THREE.Object3D[] = [];
  private planes = new Map<string, PlaneRecord>();
  private clipping: THREE.Plane[] = [];
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private offset: Vec3;
  private mode: 'view' | 'measure' | 'quiz' = 'view';
  private labelsHidden = false;
  private outlineUniform = { value: 0.45 };
  private selected: string | null = null;
  private dimOthers = false;
  private linked = new Set<string>();
  private userHidden = new Set<string>();
  private isolateId: string | null = null;
  private boneTransparent = false;
  private presetVis: PresetVisibility | null = null;
  private points: Vec3[] = [];
  private scaleEl: HTMLElement | null = null;
  private down: { x: number; y: number } | null = null;
  private onPickHandler: ((hit: PickHit | null) => void) | null = null;
  private onMeasureHandler: ((points: Vec3[]) => void) | null = null;
  private onLabelHandler: ((id: string) => void) | null = null;
  private onFrameHandler: ((distanceMm: number) => void) | null = null;
  private onShiftHandler: ((pointMm: Vec3) => void) | null = null;
  private parentOf = new Map<string, string>();
  private stageHidden = new Set<string>();
  private studyLabels: StudyLabel[] = [];
  private labelMode: 'basic' | 'surgical' | 'all' = 'basic';
  private viewStage: ViewStage | null = 'body';
  private viewStep: string | null = null;
  private labelInset = { top: 64, right: 100, bottom: 128, left: 12 };
  private shellForced: boolean | null = null;
  private readonly freeClip: THREE.Plane[] = [];
  private studyLayer: HTMLElement | null = null;
  private studyButtons = new Map<string, HTMLButtonElement>();
  private labelPlan: Placement[] = [];
  private labelPlanAt = 0;
  private flashId: string | null = null;
  private flashUntil = 0;
  private upperBody: THREE.Mesh | null = null;
  private skullLayer: THREE.Mesh | null = null;
  private skinMesh: THREE.Mesh | null = null;
  private style: RenderStyle = 'atlas';
  private hullsOn = true;
  private hullMaterial: THREE.ShaderMaterial;
  private registrationGroup: THREE.Group | null = null;
  private lastCutRadius = 0;
  private lastSkinOpacity = 1;
  private distanceRadius = 0;
  private focusRadius = 0;
  private earHotspot: THREE.Mesh | null = null;
  private cutCenter = new THREE.Vector3();
  private cutRadius = { value: 0 };
  private eacMm: Vec3 | null = null;
  private resizeObserver: ResizeObserver;
  private running = true;
  private tween: Tween | null = null;
  private outlineMaterial: THREE.MeshBasicMaterial;
  private calloutLayer: HTMLElement;
  private leaderSvg: SVGSVGElement;
  private calloutButtons = new Map<string, HTMLButtonElement>();
  private marker: THREE.Mesh | null = null;
  private markerLabel = '';
  private crosshair: THREE.Group;
  private gizmo: HTMLElement;
  private gizmoSvg: SVGSVGElement;
  private gizmoCam = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 20);
  private keyLight: THREE.DirectionalLight;
  private started = false;
  private raf = 0;
  private dirty = true;
  private interacting = false;
  private pointerDown = false;
  private drawing = false;
  private gestureUntil = 0;
  private distanceLimits: { min: number; max: number } = { ...STAGE_LIMITS.body };
  private visibleRect: VisibleRect | null = null;
  private zoomGesture: {
    cam: THREE.Vector3;
    target: THREE.Vector3;
    anchor: THREE.Vector3 | null;
    radius: number;
    scale: number;
    at: { x: number; y: number } | null;
  } | null = null;
  private pinching = false;
  private pinchStart = 0;
  private suppressTap = false;
  private lastTapAt = 0;
  private lastTapX = 0;
  private lastTapY = 0;
  private lastPick: PickHit | null = null;
  private onDoubleHandler: ((hit: PickHit) => void) | null = null;
  private lastAnchor: THREE.Vector3 | null = null;
  private outward = new THREE.Vector3();
  private applyingZoom = false;
  private lastStop = 0;
  private dragOffset = new THREE.Vector3();
  private hasDragOffset = false;
  private pendingTap = 0;
  private lastTouchAt = 0;
  private pose = new THREE.Vector3();
  private poseTarget = new THREE.Vector3();
  private poseQuat = new THREE.Quaternion();
  private pixelLive = false;
  private occluders: THREE.Object3D[] = [];
  private centers = new Map<string, THREE.Vector3>();
  private labelById = new Map<string, StudyLabel>();
  private labelOffset = new Map<string, { ox: number; oy: number }>();
  private leaderLines = new Map<string, SVGLineElement>();
  private studySvg: SVGSVGElement | null = null;
  private gizmoLines = new Map<string, SVGLineElement>();
  private worldScratch = new THREE.Vector3();
  private ndc = new THREE.Vector3();
  private rayTarget = new THREE.Vector3();
  private rayDir = new THREE.Vector3();
  private frustum = new THREE.Frustum();
  private frustumMatrix = new THREE.Matrix4();
  private sphereScratch = new THREE.Sphere();
  private cornerScratch = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, offsetMm: Vec3) {
    this.canvas = canvas;
    this.offset = [offsetMm[0], offsetMm[1], offsetMm[2]];
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = false;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.setPixelRatio(this.pixelRatio(false));
    this.renderer.localClippingEnabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.hullsOn = outlinesAllowed();
    this.scene.background = new THREE.Color(ATLAS_BACKGROUND);
    this.draco.setDecoderPath(publicUrl('draco/'));
    this.loader.setDRACOLoader(this.draco);

    this.camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, 0.05, 8000);
    this.camera.up.set(0, -1, 0);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.85;
    this.controls.zoomSpeed = 0.85;
    this.controls.enableZoom = false;
    this.controls.zoomToCursor = false;
    // A second finger cancels OrbitControls' rotate. Pinch zoom is our own.
    this.controls.touches.TWO = -1 as typeof this.controls.touches.TWO;
    this.controls.minDistance = this.distanceLimits.min;
    this.controls.maxDistance = this.distanceLimits.max;

    this.world.name = 'specimen';
    this.world.position.set(this.offset[0], this.offset[1], this.offset[2]);
    this.world.scale.set(1, 1, 1);
    this.world.add(this.structures, this.measures);
    this.scene.add(this.world);

    const hemi = new THREE.HemisphereLight('#fffaf4', '#d5d8e2', 1.35);
    const key = new THREE.DirectionalLight('#ffffff', 1.25);
    key.position.set(70, -40, -30);
    this.keyLight = key;
    const fill = new THREE.DirectionalLight('#f4f7ff', 0.55);
    fill.position.set(-50, 30, 40);
    const bounce = new THREE.DirectionalLight('#ffe4cc', 0.35);
    bounce.position.set(20, 90, -10);
    this.scene.add(hemi, key, fill, bounce);

    this.outlineMaterial = new THREE.MeshBasicMaterial({
      color: OUTLINE,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.outlineMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uOutline = this.outlineUniform;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uOutline;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize(normal) * uOutline;');
    };
    this.outlineMaterial.customProgramCacheKey = () => 'ent3d-outline';
    this.hullMaterial = createHullMaterial(this.clipping, { center: { value: this.cutCenter }, radius: this.cutRadius });

    this.crosshair = this.makeCrosshair();
    this.world.add(this.crosshair);

    const parent = canvas.parentElement ?? canvas;
    this.calloutLayer = document.createElement('div');
    this.calloutLayer.className = 'callout-layer';
    this.leaderSvg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    this.leaderSvg.classList.add('leaders');
    this.calloutLayer.append(this.leaderSvg);
    this.gizmo = document.createElement('div');
    this.gizmo.className = 'gizmo';
    this.gizmoSvg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    this.gizmoSvg.setAttribute('viewBox', '0 0 84 84');
    this.gizmo.append(this.gizmoSvg);
    for (const axis of GIZMO_AXES) {
      const label = document.createElement('span');
      label.dataset.axis = axis.id;
      label.textContent = axis.text;
      this.gizmo.append(label);
    }
    this.studyLayer = document.createElement('div');
    this.studyLayer.className = 'study-layer';
    parent.append(this.calloutLayer, this.studyLayer, this.gizmo);
    this.controls.addEventListener('start', () => {
      this.pointerDown = true;
      this.interacting = true;
      this.applyPixelRatio(true);
      this.invalidate();
    });
    this.controls.addEventListener('end', () => {
      this.pointerDown = false;
      this.interacting = false;
      this.labelPlanAt = 0;
      this.applyPixelRatio(false);
      this.invalidate();
    });
    this.controls.addEventListener('change', () => {
      if (this.drawing) return;
      this.guardOrbit();
      this.invalidate();
    });
    this.frameDefault(true);

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
    canvas.addEventListener('touchend', this.onTouchEnd);
    canvas.addEventListener('touchcancel', this.onTouchEnd);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('pointercancel', () => {
      this.down = null;
      this.pinching = false;
      this.zoomGesture = null;
      this.controls.enabled = true;
      this.clearOrbitInertia();
      this.hasDragOffset = false;
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(parent);
    this.resize();
  }

  /** Starts drawing. Call after the meshes are loaded so decode is not starved. */
  start(): void {
    if (!this.running || this.started) return;
    this.started = true;
    this.invalidate();
  }

  setScaleElement(element: HTMLElement | null): void {
    this.scaleEl = element;
  }

  setMode(mode: 'view' | 'measure' | 'quiz'): void {
    this.mode = mode;
    this.labelsHidden = mode === 'quiz';
    if (mode === 'quiz') {
      this.clearMeasurement();
      this.presetVis = null;
      this.boneTransparent = true;
      this.isolateId = null;
      this.refreshLook();
    }
    this.syncCallouts();
  }

  onPick(handler: (hit: PickHit | null) => void): void {
    this.onPickHandler = handler;
  }

  onMeasure(handler: (points: Vec3[]) => void): void {
    this.onMeasureHandler = handler;
  }

  onLabel(handler: (id: string) => void): void {
    this.onLabelHandler = handler;
  }

  onFrame(handler: (distanceMm: number) => void): void {
    this.onFrameHandler = handler;
  }

  onShiftPoint(handler: (pointMm: Vec3) => void): void {
    this.onShiftHandler = handler;
  }

  onDoublePick(handler: (hit: PickHit) => void): void {
    this.onDoubleHandler = handler;
  }

  /** Stage camera-target limits. Shell zooms stop at the minimum; smaller meshes stop sooner. */
  setDistanceLimits(min: number, max: number): void {
    this.distanceLimits = { min, max: Math.max(max, min) };
    this.controls.minDistance = this.distanceLimits.min;
    this.controls.maxDistance = this.distanceLimits.max;
  }

  /**
   * Shift the projection so the orbit centre sits in the unobscured rectangle.
   * Pass null on desktop, where the canvas itself is the view.
   */
  setVisibleRect(rect: VisibleRect | null): void {
    if (!rect || rect.width < 48 || rect.height < 48) this.visibleRect = null;
    else this.visibleRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    this.applyViewOffset();
    this.invalidate();
  }

  /** Move the orbit centre onto a tapped surface point. Distance and direction stay. */
  focusSurface(specimen: Vec3): void {
    const anchor = this.worldPoint(specimen);
    const next = orbitAbout(
      [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      [this.controls.target.x, this.controls.target.y, this.controls.target.z],
      anchor,
    );
    this.moveCamera(next.camera, next.target, [this.camera.up.x, this.camera.up.y, this.camera.up.z], this.camera.fov, false);
    this.rememberAnchor(new THREE.Vector3(...anchor), this.distanceLimits.min);
  }

  /** Fit a small sphere, used for a landmark segment such as the IAC. */
  frameSphere(center: Vec3, radiusMm: number): void {
    const world = new THREE.Vector3(...this.worldPoint(center));
    const size = Math.max(radiusMm, 1) * 2;
    const box = new THREE.Box3().setFromCenterAndSize(world, new THREE.Vector3(size, size, size));
    this.frameWorldBox(box, Math.max(radiusMm, 1));
  }

  /** Fit the union of several meshes, used for the cochlea. */
  frameIds(ids: readonly string[]): void {
    const box = new THREE.Box3();
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record || record.aggregate) continue;
      record.object.updateWorldMatrix(true, true);
      const visible = record.object.visible;
      record.object.visible = true;
      box.expandByObject(record.object);
      record.object.visible = visible;
    }
    this.frameWorldBox(box);
  }

  cameraDistance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  /** Screen position of the orbit target, in canvas pixels. */
  targetOnScreen(): { x: number; y: number; visible: boolean } {
    const width = Math.max(this.canvas.clientWidth, 1);
    const height = Math.max(this.canvas.clientHeight, 1);
    this.ndc.copy(this.controls.target).project(this.camera);
    const x = (this.ndc.x * 0.5 + 0.5) * width;
    const y = (-this.ndc.y * 0.5 + 0.5) * height;
    const visible = this.ndc.z < 1 && x >= -8 && y >= -8 && x <= width + 8 && y <= height + 8;
    return { x, y, visible };
  }

  cameraPose(): { position: Vec3; target: Vec3 } {
    return {
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
    };
  }

  crosshairVisible(): boolean {
    return this.crosshair.visible;
  }

  /** True when the auricle and skin are kept off, as in the bone and dissection views. */
  shellHidden(): boolean {
    return this.shellForced === true && this.upperBody?.visible !== true && this.skinMesh?.visible !== true;
  }

  flyTo(position: Vec3, target: Vec3, up: Vec3 = [0, -1, 0], fov = DEFAULT_FOV): void {
    this.moveCamera(this.worldPoint(position), this.worldPoint(target), up, fov, false);
  }

  /**
   * Label anchor in specimen millimetres. A centroid that falls in a hole
   * (a canal loop) is replaced by the nearest surface vertex.
   */
  surfaceLabelAnchor(id: string, centroid: Vec3): Vec3 {
    const record = this.records.get(id);
    if (!record) return centroid;
    const flat: number[] = [];
    const scratch = new THREE.Vector3();
    let triangles = 0;
    for (const mesh of record.meshes) {
      const attr = mesh.geometry.getAttribute('position');
      if (!attr) continue;
      const indexed = mesh.geometry.index;
      const count = indexed ? indexed.count / 3 : attr.count / 3;
      triangles += count;
    }
    const stride = triangles > 20000 ? 8 : 1;
    for (const mesh of record.meshes) {
      const attr = mesh.geometry.getAttribute('position');
      if (!attr) continue;
      mesh.updateWorldMatrix(true, false);
      const indexed = mesh.geometry.index;
      const count = indexed ? Math.floor(indexed.count / 3) : Math.floor(attr.count / 3);
      for (let triangle = 0; triangle < count; triangle += stride) {
        for (let vertex = 0; vertex < 3; vertex += 1) {
          const slot = indexed ? indexed.getX(triangle * 3 + vertex) : triangle * 3 + vertex;
          scratch.fromBufferAttribute(attr as THREE.BufferAttribute, slot);
          scratch.applyMatrix4(mesh.matrixWorld);
          const local = this.world.worldToLocal(scratch.clone());
          flat.push(local.x, local.y, local.z);
        }
      }
    }
    return labelAnchorPoint(centroid, flat, null, 1);
  }

  structureCenter(id: string): Vec3 | null {
    const record = this.records.get(id);
    if (!record) return null;
    const box = new THREE.Box3();
    record.object.updateWorldMatrix(true, true);
    record.object.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.geometry) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (!mesh.geometry.boundingBox) return;
      const next = mesh.geometry.boundingBox.clone();
      mesh.updateWorldMatrix(true, false);
      next.applyMatrix4(mesh.matrixWorld);
      box.union(next);
    });
    if (box.isEmpty()) return null;
    const local = this.world.worldToLocal(box.getCenter(new THREE.Vector3()));
    return [local.x, local.y, local.z];
  }

  setStageHidden(ids: Iterable<string>): void {
    this.stageHidden = new Set(ids);
    this.refreshLook();
  }

  setLabelMode(mode: 'basic' | 'surgical' | 'all'): void {
    this.labelMode = mode;
    this.labelPlanAt = 0;
    this.invalidate();
  }

  setStudyLabels(labels: StudyLabel[]): void {
    this.studyLabels = labels;
    this.labelById = new Map(labels.map((label) => [label.id, label]));
    this.labelPlanAt = 0;
    this.invalidate();
  }

  /** Crumb stage and dissection step. The label mode is filtered with these, not by distance alone. */
  setViewContext(stage: ViewStage | null, stepId: string | null): void {
    this.viewStage = stage;
    this.viewStep = stepId;
    this.labelPlanAt = 0;
    this.invalidate();
  }

  setLabelInset(inset: { top: number; right: number; bottom: number; left: number }): void {
    this.labelInset = inset;
    this.labelPlanAt = 0;
    this.invalidate();
  }

  /**
   * Hide the skin and auricle without opening a spherical window in the bone.
   * `null` follows the cutaway radius again.
   */
  setShellOpen(open: boolean | null): void {
    this.shellForced = open;
    if (open) {
      this.distanceRadius = 0;
      this.focusRadius = 0;
      this.cutRadius.value = 0;
    }
    this.applyShellVisibility();
    this.invalidate();
  }

  clearPreset(): void {
    this.presetVis = null;
    this.setClipping(null);
    this.setMarker(null, '');
    this.refreshLook();
  }

  /** Union of structure bounds in specimen millimetres. */
  boundsOf(ids: readonly string[]): { min: Vec3; max: Vec3 } | null {
    const box = new THREE.Box3();
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record || record.aggregate) continue;
      record.object.updateWorldMatrix(true, true);
      const visible = record.object.visible;
      record.object.visible = true;
      box.expandByObject(record.object);
      record.object.visible = visible;
    }
    return this.specimenBox(box);
  }

  /** Skin, auricle, and skull, in specimen millimetres. */
  entryBounds(): { min: Vec3; max: Vec3 } | null {
    const box = new THREE.Box3();
    for (const mesh of [this.skinMesh, this.upperBody, this.skullLayer]) {
      if (!mesh) continue;
      mesh.updateWorldMatrix(true, true);
      const visible = mesh.visible;
      mesh.visible = true;
      box.expandByObject(mesh);
      mesh.visible = visible;
    }
    return this.specimenBox(box);
  }

  private specimenBox(box: THREE.Box3): { min: Vec3; max: Vec3 } | null {
    if (box.isEmpty()) return null;
    const min = this.world.worldToLocal(box.min.clone());
    const max = this.world.worldToLocal(box.max.clone());
    return {
      min: [Math.min(min.x, max.x), Math.min(min.y, max.y), Math.min(min.z, max.z)],
      max: [Math.max(min.x, max.x), Math.max(min.y, max.y), Math.max(min.z, max.z)],
    };
  }

  flash(id: string): void {
    this.flashId = id;
    this.flashUntil = performance.now() + 700;
  }

  async loadStructure(
    id: string,
    url: string,
    color: string,
    layer: string,
    opacity: number,
    label: string,
    meta?: { parentId?: string; aggregate?: boolean },
  ): Promise<void> {
    const gltf = await this.loader.loadAsync(url);
    const root = gltf.scene;
    const materials: THREE.Material[] = [];
    const meshes: THREE.Mesh[] = [];
    const outlines: THREE.Mesh[] = [];
    const hulls: THREE.Mesh[] = [];
    const side = id === 'bone' || id === 'tympanic-membrane' || id.startsWith('tm-') ? THREE.DoubleSide : THREE.FrontSide;
    const found: THREE.Mesh[] = [];
    root.traverse((obj) => {
      if (isMesh(obj)) found.push(obj);
    });
    for (const obj of found) {
      this.warnIfScaled(obj, id);
      const material = this.makeStructureMaterial(id, color, opacity, side);
      const previous = obj.material;
      obj.material = material;
      const old = Array.isArray(previous) ? previous : [previous];
      old.forEach((item) => item.dispose());
      materials.push(material);
      meshes.push(obj);
      obj.userData.structureId = id;
      obj.userData.kind = 'structure';
      obj.matrixAutoUpdate = false;
      obj.updateMatrix();
      if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
      if (!obj.geometry.boundingSphere) obj.geometry.computeBoundingSphere();
      if (!meta?.aggregate) this.pickables.push(obj);
      const outline = new THREE.Mesh(obj.geometry, this.outlineMaterial);
      outline.matrixAutoUpdate = false;
      outline.updateMatrix();
      outline.visible = false;
      outline.renderOrder = 29;
      outline.userData.kind = 'outline';
      obj.add(outline);
      outlines.push(outline);
      const triangles = obj.geometry.index ? obj.geometry.index.count / 3 : (obj.geometry.getAttribute('position')?.count ?? 0) / 3;
      if (this.hullsOn && triangles > 0 && triangles < 40000) {
        const hull = new THREE.Mesh(obj.geometry, this.hullFor(cutScaleFor(id)));
        (hull.material as THREE.ShaderMaterial).clippingPlanes = this.planesFor(id);
        hull.visible = this.style === 'atlas';
        hull.renderOrder = 2;
        hull.userData.kind = 'hull';
        obj.add(hull);
        hulls.push(hull);
      }
    }
    root.userData.structureId = id;
    root.matrixAutoUpdate = false;
    root.updateMatrix();
    this.structures.add(root);
    root.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.isEmpty() ? 1 : box.getSize(new THREE.Vector3()).length();
    if (!box.isEmpty()) this.centers.set(id, box.getCenter(new THREE.Vector3()));
    const record: StructureRecord = {
      id,
      layer,
      object: root,
      materials,
      meshes,
      outlines,
      hulls,
      opacity,
      envelope: isEnvelope(id),
      size,
      color,
      label,
      parentId: meta?.parentId ?? null,
      aggregate: meta?.aggregate === true,
      side,
    };
    if (meta?.parentId) this.parentOf.set(id, meta.parentId);
    this.records.set(id, record);
    this.applyLook(record);
    this.invalidate();
  }

  setLabel(id: string, label: string): void {
    const record = this.records.get(id);
    if (record) record.label = label;
    this.syncCallouts();
    this.invalidate();
  }

  setHidden(id: string, hidden: boolean): void {
    if (hidden) this.userHidden.add(id);
    else this.userHidden.delete(id);
    if (hidden && this.selected === id) this.select(null, false);
    if (hidden && this.isolateId === id) this.isolateId = null;
    this.refreshLook();
  }

  hiddenIds(): string[] {
    return [...this.userHidden];
  }

  setIsolate(id: string | null): void {
    this.isolateId = id;
    this.refreshLook();
  }

  isolatedId(): string | null {
    return this.isolateId;
  }

  setBoneTransparent(on: boolean): void {
    this.boneTransparent = on;
    this.refreshLook();
  }

  boneIsTransparent(): boolean {
    return this.boneTransparent;
  }

  select(id: string | null, frame = true): void {
    this.selected = id;
    this.dimOthers = id !== null;
    this.linked.clear();
    this.focusCut(id);
    this.refreshLook();
    if (id && frame) this.frameStructure(id);
    else this.syncCallouts();
  }

  /** Quiz highlight. The target stays opaque and is drawn in front of bone. */
  highlight(id: string | null, dimOthers: boolean, frame = false, spanMm = SELECTION_SPAN_MM, fit = false): void {
    this.selected = id;
    this.dimOthers = dimOthers && id !== null;
    this.linked.clear();
    this.focusCut(id);
    this.refreshLook();
    if (id && frame) this.frameStructure(id, spanMm, fit);
  }

  /** Kept so related structures can be named. Opacity stays on the selection rule. */
  link(ids: string[]): void {
    this.linked = new Set(ids.filter((id) => id !== this.selected));
    this.refreshLook();
  }

  selectedId(): string | null {
    return this.selected;
  }

  frameDefault(immediate = false): void {
    this.presetVis = null;
    this.selected = null;
    this.dimOthers = false;
    this.linked.clear();
    this.isolateId = null;
    this.userHidden = new Set(['external-auditory-canal']);
    this.boneTransparent = false;
    this.shellForced = null;
    this.labelsHidden = this.mode === 'quiz';
    this.setMarker(null, '');
    this.focusCut(null);
    this.refreshLook();
    this.moveCamera(this.worldPoint(DEFAULT_CAMERA.position), this.worldPoint(DEFAULT_CAMERA.target), DEFAULT_CAMERA.up, DEFAULT_CAMERA.fov, immediate);
    this.setClipping(null);
  }

  private boundingRadius(id: string): number {
    const box = new THREE.Box3();
    for (const itemId of [id, ...this.descendantIds(id)]) {
      const record = this.records.get(itemId);
      if (!record || record.aggregate) continue;
      record.object.updateWorldMatrix(true, true);
      const visible = record.object.visible;
      record.object.visible = true;
      box.expandByObject(record.object);
      record.object.visible = visible;
    }
    if (box.isEmpty()) return 4;
    return Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1.2);
  }

  frameStructure(id: string, spanMm = SELECTION_SPAN_MM, fit = false): void {
    const box = new THREE.Box3();
    const ids = [id, ...this.descendantIds(id)];
    for (const itemId of ids) {
      const record = this.records.get(itemId);
      if (!record || record.aggregate) continue;
      record.object.updateWorldMatrix(true, true);
      const visible = record.object.visible;
      record.object.visible = true;
      box.expandByObject(record.object);
      record.object.visible = visible;
    }
    if (box.isEmpty()) return;
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1.2);
    if (this.visibleRect) {
      this.frameWorldBox(box, radius);
      return;
    }
    const center = box.getCenter(new THREE.Vector3());
    const direction = this.camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-4) direction.set(1, -0.05, 0.15);
    direction.normalize();
    const framed = framingSpanMm(radius, this.canvas.clientWidth, this.canvas.clientHeight);
    const span = fit ? Math.min(spanMm, Math.max(16, radius * 7)) : framed;
    const fov = (this.camera.fov * Math.PI) / 180;
    let distance = span / (2 * Math.tan(fov / 2));
    distance = this.clampFrameDistance(distance, radius);
    const position = center.clone().add(direction.multiplyScalar(distance));
    this.moveCamera([position.x, position.y, position.z], [center.x, center.y, center.z], [this.camera.up.x, this.camera.up.y, this.camera.up.z], this.camera.fov, false);
  }

  private frameWorldBox(box: THREE.Box3, radiusHint?: number): void {
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = radiusHint ?? Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1.2);
    const direction = this.camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-4) direction.set(0.2, -0.2, -1);
    direction.normalize();
    const width = Math.max(this.canvas.clientWidth, 1);
    const height = Math.max(this.canvas.clientHeight, 1);
    let distance: number;
    if (this.visibleRect) {
      distance = fitDistanceMm({
        radiusMm: radius,
        fovDeg: this.camera.fov,
        canvasWidth: width,
        canvasHeight: height,
        visibleWidth: this.visibleRect.width,
        visibleHeight: this.visibleRect.height,
        margin: 1.55,
      });
    } else {
      const framed = framingSpanMm(radius, width, height);
      const fov = (this.camera.fov * Math.PI) / 180;
      distance = framed / (2 * Math.tan(fov / 2));
    }
    distance = this.clampFrameDistance(distance, radius);
    const position = center.clone().add(direction.multiplyScalar(distance));
    this.moveCamera([position.x, position.y, position.z], [center.x, center.y, center.z], [this.camera.up.x, this.camera.up.y, this.camera.up.z], this.camera.fov, false);
  }

  private clampFrameDistance(distance: number, radius: number): number {
    const stop = stopDistanceMm(zoomStructureSize('framed', radius), this.distanceLimits.min);
    return Math.min(this.distanceLimits.max, Math.max(distance, this.distanceLimits.min, stop));
  }

  applyPreset(preset: Pick<DissectionStep, 'camera' | 'clipping' | 'visible' | 'hidden' | 'ghosted' | 'highlight'>): void {
    this.presetVis = {
      hidden: new Set(preset.hidden ?? []),
      ghosted: new Set(preset.ghosted ?? []),
      visible: preset.visible ? new Set(preset.visible) : null,
    };
    this.isolateId = null;
    this.stageHidden = new Set();
    const highlight = preset.highlight ?? null;
    this.selected = highlight;
    this.dimOthers = false;
    this.linked.clear();
    this.shellForced = true;
    this.distanceRadius = 0;
    this.focusRadius = 0;
    this.cutRadius.value = 0;
    this.applyShellVisibility();
    this.refreshLook();
    const position = preset.camera.position;
    const target = preset.camera.target;
    const up = preset.camera.up ?? [0, -1, 0];
    const fov = preset.camera.fov ?? DEFAULT_FOV;
    const direction: Vec3 = [position[0] - target[0], position[1] - target[1], position[2] - target[2]];
    const authored = Math.hypot(direction[0], direction[1], direction[2]) || 1;
    const distance = distanceForAspect(authored, fov, this.canvas.clientWidth, this.canvas.clientHeight);
    const next = placeAlong(target, direction, distance);
    this.moveCamera(this.worldPoint(next), this.worldPoint(target), up, fov, false);
    this.setClipping(preset.clipping?.enabled ? preset.clipping : null);
  }

  setMarker(position: Vec3 | null, label: string): void {
    this.markerLabel = position ? label : '';
    if (!position) {
      if (this.marker) this.marker.visible = false;
      this.syncCallouts();
      this.invalidate();
      return;
    }
    if (!this.marker) {
      this.marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.45, 18, 12),
        new THREE.MeshBasicMaterial({ color: '#8C2F1B', depthTest: false, toneMapped: false }),
      );
      this.marker.renderOrder = 40;
      this.marker.userData.kind = 'marker';
      this.world.add(this.marker);
    }
    this.marker.visible = true;
    this.marker.position.set(position[0], position[1], position[2]);
    this.syncCallouts();
    this.invalidate();
  }

  setCrosshair(point: Vec3 | null): void {
    this.crosshair.visible = point !== null;
    if (point) this.crosshair.position.set(point[0], point[1], point[2]);
    this.invalidate();
  }

  contourSources(skipBone = true): ContourSource[] {
    const sources: ContourSource[] = [];
    for (const record of this.records.values()) {
      if (!record.object.visible) continue;
      if (skipBone && record.id === 'bone') continue;
      for (const mesh of record.meshes) {
        const position = mesh.geometry.getAttribute('position');
        if (!position) continue;
        sources.push({
          id: record.id,
          color: record.color,
          positions: position.array as ArrayLike<number>,
          index: mesh.geometry.index ? (mesh.geometry.index.array as ArrayLike<number>) : null,
          stride: record.id === 'sinus-dura' ? 2 : 1,
        });
      }
    }
    return sources;
  }

  clearMeasurement(): void {
    if (this.points.length === 0) return;
    this.points = [];
    this.redrawMeasurement();
    this.onMeasureHandler?.([]);
  }

  measurementPoints(): Vec3[] {
    return this.points.map((point) => [point[0], point[1], point[2]]);
  }

  setPlane(options: {
    id: string;
    visible: boolean;
    opacity: number;
    pose: SlicePose | null;
    image: HTMLImageElement | null;
    flipY?: boolean;
  }): void {
    let record = this.planes.get(options.id);
    if (!record) {
      const texture = new THREE.Texture();
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = options.flipY === true;
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: options.opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      mesh.userData.kind = 'ct';
      mesh.renderOrder = 2;
      this.world.add(mesh);
      record = { mesh, texture, material };
      this.planes.set(options.id, record);
    }
    record.material.opacity = options.opacity;
    record.material.transparent = options.opacity < 0.98;
    record.mesh.visible = options.visible && options.pose !== null && options.image !== null;
    if (options.image && record.texture.image !== options.image) {
      record.texture.image = options.image;
      record.texture.needsUpdate = true;
    }
    if (options.pose) this.placePlane(record, options.pose, options.flipY === true);
    this.invalidate();
  }

  dispose(): void {
    this.running = false;
    this.started = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('touchstart', this.onTouchStart);
    this.canvas.removeEventListener('touchmove', this.onTouchMove);
    this.canvas.removeEventListener('touchend', this.onTouchEnd);
    this.canvas.removeEventListener('touchcancel', this.onTouchEnd);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.controls.dispose();
    this.draco.dispose();
    this.outlineMaterial.dispose();
    this.renderer.dispose();
    this.calloutLayer.remove();
    this.studyLayer?.remove();
    this.gizmo.remove();
  }

  private worldPoint(specimen: Vec3): Vec3 {
    return [specimen[0] + this.offset[0], specimen[1] + this.offset[1], specimen[2] + this.offset[2]];
  }

  private invalidate(): void {
    this.dirty = true;
    this.requestFrame();
  }

  private requestFrame(): void {
    if (!this.started || !this.running || this.raf) return;
    this.raf = requestAnimationFrame(this.drawFrame);
  }

  private drawFrame = (): void => {
    this.raf = 0;
    if (!this.running) return;
    this.drawing = true;
    const again = this.tick();
    this.drawing = false;
    if (again) this.requestFrame();
  };

  private pixelRatio(interacting: boolean): number {
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const width = this.canvas.clientWidth || window.innerWidth || 1280;
    return choosePixelRatio(window.devicePixelRatio || 1, coarse || width < 820, interacting);
  }

  private applyPixelRatio(interacting: boolean): void {
    const next = this.pixelRatio(interacting);
    if (this.pixelLive === interacting && Math.abs(this.renderer.getPixelRatio() - next) < 0.01) return;
    this.pixelLive = interacting;
    this.renderer.setPixelRatio(next);
    this.resize();
  }

  /** Draws one frame. Returns true while the camera is still moving. */
  private tick(): boolean {
    if (!this.running) return false;
    const now = performance.now();
    const beforeTween = this.tween !== null;
    this.stepTween(now);
    const moved = this.controls.update();
    this.limitDragStep();
    const tweening = this.tween !== null;
    if (relayoutOnTweenEnd(beforeTween, tweening)) this.labelPlanAt = 0;
    const drifting = moved && this.meaningfulMove();
    if (this.interacting && !this.pointerDown && now >= this.gestureUntil && !tweening) {
      this.interacting = false;
      this.labelPlanAt = 0;
      this.dirty = true;
      this.applyPixelRatio(false);
    }
    const active = this.dirty || drifting || beforeTween || this.interacting || this.pointerDown;
    if (!active) return false;
    this.dirty = false;
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.keyLight.position.copy(this.camera.position);
    const worldHeight = 2 * Math.tan((this.camera.fov * Math.PI) / 360) * Math.max(distance, 0.001);
    const pxPerMm = this.canvas.clientHeight / worldHeight;
    this.outlineUniform.value = Math.min(1.6, Math.max(distance < 40 ? 0.55 : 0.2, 2.6 / Math.max(pxPerMm, 0.5)));
    this.updateScaleBar();
    this.onFrameHandler?.(distance);
    this.cullContextMeshes();
    this.projectCallouts();
    this.projectStudyLabels(now);
    this.projectGizmo();
    this.renderer.render(this.scene, this.camera);
    this.rememberPose();
    return drifting || tweening || this.interacting || this.pointerDown || this.dirty;
  }

  private meaningfulMove(): boolean {
    const drift = this.camera.position.distanceToSquared(this.pose) + this.controls.target.distanceToSquared(this.poseTarget);
    const turn = 1 - this.poseQuat.dot(this.camera.quaternion) ** 2;
    return drift > 1e-4 || turn > 1e-8;
  }

  private rememberPose(): void {
    this.pose.copy(this.camera.position);
    this.poseTarget.copy(this.controls.target);
    this.poseQuat.copy(this.camera.quaternion);
  }

  private resize(): void {
    const parent = this.canvas.parentElement ?? this.canvas;
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    if (width < 2 || height < 2) return;
    this.camera.aspect = width / height;
    this.applyViewOffset();
    if (!this.visibleRect) this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    const resolution = this.hullMaterial?.uniforms.uResolution.value as THREE.Vector2 | undefined;
    if (resolution) resolution.set(this.renderer.domElement.width, this.renderer.domElement.height);
    this.labelPlanAt = 0;
    this.invalidate();
  }

  private updateScaleBar(): void {
    if (!this.scaleEl) return;
    const distance = this.camera.position.distanceTo(this.controls.target);
    const verticalFov = (this.camera.fov * Math.PI) / 180;
    const worldHeight = 2 * Math.tan(verticalFov / 2) * Math.max(distance, 0.001);
    const pxPerMm = this.canvas.clientHeight / worldHeight;
    const chosen = chooseScaleMm(pxPerMm);
    const line = this.scaleEl.querySelector<HTMLElement>('[data-scale-line]');
    const label = this.scaleEl.querySelector<HTMLElement>('[data-scale-label]');
    const widthPx = `${Math.max(1, Math.round(chosen.px))}px`;
    const text = `${chosen.mm} mm`;
    if (line && line.style.width !== widthPx) line.style.width = widthPx;
    if (label && label.textContent !== text) label.textContent = text;
  }

  private warnIfScaled(mesh: THREE.Object3D, id: string): void {
    let node: THREE.Object3D | null = mesh;
    while (node) {
      const scale = node.scale;
      if (Math.abs(scale.x - 1) > 1e-4 || Math.abs(scale.y - 1) > 1e-4 || Math.abs(scale.z - 1) > 1e-4) {
        console.warn(`Mesh scale left untouched for ${id}: ${scale.x}, ${scale.y}, ${scale.z}`);
        return;
      }
      node = node.parent;
    }
  }

  private refreshLook(): void {
    for (const record of this.records.values()) this.applyLook(record);
    this.syncCallouts();
    this.invalidate();
  }

  private shown(record: StructureRecord): boolean {
    if (record.aggregate) return false;
    if (this.userHidden.has(record.id) || (record.parentId && this.userHidden.has(record.parentId))) return false;
    if (this.stageHidden.has(record.id)) return false;
    if (this.isolateId) return record.id === this.isolateId || record.parentId === this.isolateId || this.ancestorIs(record.id, this.isolateId);
    if (!this.presetVis) return true;
    const hidden = this.presetVis.hidden.has(record.id) || this.ancestorHidden(record.id);
    if (hidden) return false;
    if (this.presetVis.visible && !this.presetListed(record.id)) return false;
    return true;
  }

  private descendantIds(id: string): string[] {
    const found: string[] = [];
    for (const [child, parent] of this.parentOf) {
      if (parent === id || this.ancestorIs(child, id)) found.push(child);
    }
    return found;
  }

  private ancestorIs(id: string, target: string): boolean {
    let parent = this.parentOf.get(id) ?? null;
    while (parent) {
      if (parent === target) return true;
      parent = this.parentOf.get(parent) ?? null;
    }
    return false;
  }

  private ancestorHidden(id: string): boolean {
    let parent = this.parentOf.get(id) ?? null;
    while (parent) {
      if (this.presetVis?.hidden.has(parent)) return true;
      parent = this.parentOf.get(parent) ?? null;
    }
    return false;
  }

  private presetListed(id: string): boolean {
    if (!this.presetVis?.visible) return true;
    if (this.presetVis.visible.has(id) || this.presetVis.ghosted.has(id)) return true;
    let parent = this.parentOf.get(id) ?? null;
    while (parent) {
      if (this.presetVis.visible.has(parent) || this.presetVis.ghosted.has(parent)) return true;
      parent = this.parentOf.get(parent) ?? null;
    }
    return false;
  }

  private applyLook(record: StructureRecord): void {
    const visible = this.shown(record);
    record.object.visible = visible;
    const inSelection = this.selected !== null && (record.id === this.selected || this.ancestorIs(record.id, this.selected));
    const onTop = inSelection && visible;
    // Selection framing sits near 60–80 mm so the scale bar reads about 10 mm.
    // Neighbours stay coloured through that range. Presets leave dimOthers off.
    const close = this.dimOthers && this.selected !== null && this.selected !== 'bone' && this.cameraDistance() < 160;
    const family = this.focusFamily(this.selected);
    const neighbour = close && !inSelection && family !== null && this.isNeighbour(record.id, family);
    const envelope = record.id === 'bone' || record.id === 'sinus-dura' || record.id === 'external-auditory-canal';
    const dimmed = close && !inSelection && !neighbour && record.id !== 'bone';
    const defaultGhost = !this.presetVis && record.id === 'sinus-dura';
    const presetGhost = this.presetVis?.ghosted.has(record.id) === true;
    let opacity = displayOpacity({
      id: record.id,
      base: record.opacity,
      selectedId: inSelection ? record.id : this.selected,
      dimOthers: this.dimOthers && !inSelection && !close,
      ghost: presetGhost || defaultGhost,
      boneTransparent: this.boneTransparent,
    });
    if (record.id === 'bone' && !this.boneTransparent && !presetGhost) opacity = 1;
    else if (close && envelope) opacity = Math.min(opacity, 0.08);
    else if (close && (record.id === 'tympanic-membrane' || record.id.startsWith('tm-')) && (family === 'malleus' || family === 'incus' || family === 'stapes')) opacity = 0.34;
    else if (close && neighbour) opacity = 0.82;
    else if (close && !inSelection) opacity = Math.min(opacity, 0.08);
    if (onTop && opacity > 0.9) opacity = 0.995;
    const peel = !this.selected && this.cutRadius.value > 8 && this.cameraDistance() < 150;
    if (peel && (record.layer === 'vessel' || record.layer === 'sinus' || record.layer === 'nerve' || record.layer === 'inner-ear')) opacity = 0.05;
    if (peel && record.layer === 'membrane') opacity = 0.62;
    const atlas = this.style === 'atlas';
    const ramp = dimmed
      ? { lit: DIM_GRAY, shadow: '#bdbbb6', highlight: '#f7f5f2' }
      : illustrationRamp(record.id, record.color);
    for (const material of record.materials) {
      if (atlas && material instanceof THREE.ShaderMaterial && material.uniforms.uLit) {
        paintAtlas(material, ramp, opacity, onTop);
        if (material.uniforms.uRim) material.uniforms.uRim.value = 0.85;
      } else if (material instanceof THREE.MeshStandardMaterial) {
        material.color.set(dimmed ? DIM_GRAY : record.color);
        material.opacity = opacity;
        material.transparent = opacity < 0.98;
        material.depthWrite = !onTop && opacity >= 0.9;
        material.depthTest = !onTop;
        material.polygonOffset = opacity < 0.98;
        material.polygonOffsetFactor = 1;
        material.polygonOffsetUnits = 1;
      }
    }
    for (const mesh of record.meshes) mesh.renderOrder = onTop ? 30 : 0;
    const flashing = this.flashId === record.id && performance.now() < this.flashUntil;
    const viewClip = record.id === 'bone' && (this.focusRadius > 0 || this.cutRadius.value > 8) ? 1 : 0;
    for (const material of record.materials) this.paintViewClip(material, viewClip);
    for (const hull of record.hulls) this.paintViewClip(hull.material, viewClip);
    const ends = record.id.startsWith('fn-') ? this.segmentEnds(record) : null;
    for (const material of record.materials) {
      if (!(material instanceof THREE.ShaderMaterial) || !material.uniforms.uEndBand) continue;
      material.uniforms.uEndBand.value = ends ? 1.15 : 0;
      if (ends) {
        material.uniforms.uEndA.value.copy(ends[0]);
        material.uniforms.uEndB.value.copy(ends[1]);
      }
    }
    for (const outline of record.outlines) outline.visible = !atlas && (onTop || flashing);
    for (const hull of record.hulls) hull.visible = atlas && visible && opacity > 0.2 && record.layer !== 'membrane';
  }

  /** Long-axis ends of a nerve segment, in world space, so the shader can ring the joint. */
  private segmentEnds(record: StructureRecord): [THREE.Vector3, THREE.Vector3] | null {
    if (record.ends) return record.ends;
    const box = new THREE.Box3();
    for (const mesh of record.meshes) {
      mesh.updateWorldMatrix(true, false);
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (!mesh.geometry.boundingBox) continue;
      box.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
    }
    if (box.isEmpty()) return null;
    const size = box.getSize(new THREE.Vector3());
    const min = box.min;
    const max = box.max;
    const mid = (a: number, b: number) => (a + b) / 2;
    const ends: [THREE.Vector3, THREE.Vector3] =
      size.y >= size.x && size.y >= size.z
        ? [new THREE.Vector3(mid(min.x, max.x), min.y, mid(min.z, max.z)), new THREE.Vector3(mid(min.x, max.x), max.y, mid(min.z, max.z))]
        : size.x >= size.z
          ? [new THREE.Vector3(min.x, mid(min.y, max.y), mid(min.z, max.z)), new THREE.Vector3(max.x, mid(min.y, max.y), mid(min.z, max.z))]
          : [new THREE.Vector3(mid(min.x, max.x), mid(min.y, max.y), min.z), new THREE.Vector3(mid(min.x, max.x), mid(min.y, max.y), max.z)];
    record.ends = ends;
    return ends;
  }

  private paintViewClip(material: THREE.Material | THREE.Material[], viewClip: number): void {
    const list = Array.isArray(material) ? material : [material];
    for (const item of list) {
      if (!(item instanceof THREE.ShaderMaterial) || !item.uniforms.uViewClip) continue;
      item.uniforms.uViewClip.value = viewClip;
      item.uniforms.uViewRadius.value = viewClip > 0 ? (this.focusRadius > 0 ? Math.min(this.focusRadius, 24) : 18) : 0;
    }
  }

  /** Parent the selection belongs to when a part, not the whole bone, is picked. */
  private focusFamily(id: string | null): string | null {
    if (!id) return null;
    const parent = this.parentOf.get(id) ?? null;
    if (id === 'facial-nerve' || parent === 'facial-nerve' || id.startsWith('fn-')) return 'facial-nerve';
    if (id === 'incus' || parent === 'incus') return 'incus';
    if (id === 'stapes' || parent === 'stapes') return 'stapes';
    if (id === 'tympanic-membrane' || parent === 'tympanic-membrane' || id.startsWith('tm-')) return 'tympanic-membrane';
    if (id === 'malleus' || parent === 'malleus') return 'malleus';
    return id;
  }

  private isNeighbour(id: string, family: string): boolean {
    const groups: Record<string, string[]> = {
      malleus: ['incus', 'stapes', 'tympanic-membrane', 'tm-pars-tensa', 'tm-pars-flaccida', 'chorda-tympani'],
      incus: ['malleus', 'stapes', 'tympanic-membrane', 'tm-pars-tensa', 'tm-pars-flaccida'],
      stapes: ['malleus', 'incus', 'tympanic-membrane', 'tm-pars-tensa', 'tm-pars-flaccida'],
      'tympanic-membrane': ['malleus', 'incus', 'stapes', 'chorda-tympani'],
      'facial-nerve': [],
    };
    const list = groups[family] ?? [];
    if (list.includes(id)) return true;
    const parent = this.parentOf.get(id);
    return parent !== undefined && list.includes(parent);
  }

  /** Surgical cuts open bone and sinus only. Nerves and ossicles stay whole. */
  private planesFor(id: string): THREE.Plane[] {
    return id === 'bone' || id === 'sinus-dura' ? this.clipping : this.freeClip;
  }

  private setClipping(clip: { normal: Vec3; constant: number } | null): void {
    this.clipping.length = 0;
    if (clip) {
      const world = worldClippingPlane(clip.normal, clip.constant, this.offset);
      const normal = new THREE.Vector3(world.normal[0], world.normal[1], world.normal[2]);
      const length = normal.length() || 1;
      normal.multiplyScalar(1 / length);
      this.clipping.push(new THREE.Plane(normal, world.constant / length));
    }
    for (const record of this.records.values()) {
      for (const material of record.materials) material.needsUpdate = true;
    }
    for (const mesh of [this.skinMesh, this.skullLayer, this.upperBody]) {
      const material = mesh?.material;
      if (material && !Array.isArray(material)) material.needsUpdate = true;
    }
    if (this.hullMaterial) this.hullMaterial.needsUpdate = true;
  }

  private placePlane(record: PlaneRecord, pose: SlicePose, flipY: boolean): void {
    const u = new THREE.Vector3(pose.u[0], pose.u[1], pose.u[2]).normalize();
    const v = new THREE.Vector3(pose.v[0], pose.v[1], pose.v[2]).normalize();
    const normal = new THREE.Vector3().crossVectors(u, v).normalize();
    const basis = new THREE.Matrix4().makeBasis(u, v, normal);
    record.mesh.quaternion.setFromRotationMatrix(basis);
    record.mesh.position.set(pose.position[0], pose.position[1], pose.position[2]);
    record.mesh.scale.set(1, 1, 1);
    record.mesh.geometry.dispose();
    record.mesh.geometry = new THREE.PlaneGeometry(pose.width, pose.height);
    record.texture.flipY = flipY;
    record.texture.wrapS = THREE.ClampToEdgeWrapping;
    record.texture.wrapT = THREE.ClampToEdgeWrapping;
    record.texture.repeat.set(1, 1);
    record.texture.offset.set(0, 0);
    record.texture.center.set(0, 0);
    record.texture.needsUpdate = true;
  }

  private makeCrosshair(): THREE.Group {
    const group = new THREE.Group();
    group.visible = false;
    group.renderOrder = 41;
    const material = new THREE.MeshBasicMaterial({ color: '#8C2F1B', depthTest: false, toneMapped: false });
    const arm = (axis: 'x' | 'y' | 'z') => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(axis === 'x' ? 14 : 0.12, axis === 'y' ? 14 : 0.12, axis === 'z' ? 14 : 0.12), material);
      mesh.renderOrder = 41;
      return mesh;
    };
    group.add(arm('x'), arm('y'), arm('z'));
    return group;
  }

  private redrawMeasurement(): void {
    for (const child of this.measures.children) {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (!Array.isArray(material)) material?.dispose();
    }
    this.measures.clear();
    for (const point of this.points) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.35, 16, 10),
        new THREE.MeshBasicMaterial({ color: '#8C2F1B', depthTest: false }),
      );
      mesh.position.set(point[0], point[1], point[2]);
      mesh.renderOrder = 35;
      this.measures.add(mesh);
    }
    if (this.points.length === 2) {
      const start = new THREE.Vector3(...this.points[0]);
      const end = new THREE.Vector3(...this.points[1]);
      const direction = end.clone().sub(start);
      const length = direction.length();
      if (length > 0.001) {
        const mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.08, 0.08, length, 8),
          new THREE.MeshBasicMaterial({ color: '#8C2F1B', depthTest: false }),
        );
        mesh.position.copy(start).add(end).multiplyScalar(0.5);
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
        mesh.renderOrder = 35;
        this.measures.add(mesh);
      }
    }
    this.invalidate();
  }

  private moveCamera(position: Vec3, target: Vec3, up: Vec3, fov: number, immediate: boolean): void {
    this.lastAnchor = null;
    const toP = new THREE.Vector3(...position);
    const toT = new THREE.Vector3(...target);
    const toU = new THREE.Vector3(...up).normalize();
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (immediate || reduce) {
      this.tween = null;
      this.camera.position.copy(toP);
      this.controls.target.copy(toT);
      this.camera.up.copy(toU);
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this.invalidate();
      return;
    }
    this.tween = {
      fromP: this.camera.position.clone(),
      toP,
      fromT: this.controls.target.clone(),
      toT,
      fromU: this.camera.up.clone(),
      toU,
      fromF: this.camera.fov,
      toF: fov,
      start: performance.now(),
    };
    this.invalidate();
  }

  private stepTween(now: number): void {
    if (!this.tween) return;
    const t = Math.min(1, (now - this.tween.start) / TWEEN_MS);
    const e = ease(t);
    this.camera.position.lerpVectors(this.tween.fromP, this.tween.toP, e);
    this.controls.target.lerpVectors(this.tween.fromT, this.tween.toT, e);
    this.camera.up.copy(this.tween.fromU).lerp(this.tween.toU, e).normalize();
    this.camera.fov = this.tween.fromF + (this.tween.toF - this.tween.fromF) * e;
    this.camera.updateProjectionMatrix();
    if (t >= 1) this.tween = null;
  }

  private syncCallouts(): void {
    const wanted = new Set<string>();
    if (!this.labelsHidden) {
      if (this.studyLabels.length === 0 && this.selected && this.records.get(this.selected)?.object.visible) wanted.add(this.selected);
      else if (!this.selected && this.studyLabels.length === 0) {
        for (const id of INTRO_LABELS) {
          const record = this.records.get(id);
          if (record?.object.visible) wanted.add(id);
        }
      }
      if (this.marker?.visible && this.markerLabel) wanted.add('marker');
    }
    for (const [id, button] of this.calloutButtons) {
      if (!wanted.has(id)) {
        button.remove();
        this.calloutButtons.delete(id);
      }
    }
    for (const id of wanted) {
      if (this.calloutButtons.has(id)) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'callout';
      button.dataset.labelId = id;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        event.preventDefault();
        this.onLabelHandler?.(id === 'marker' ? '' : id);
      });
      this.calloutLayer.append(button);
      this.calloutButtons.set(id, button);
    }
    this.projectCallouts();
  }

  private projectCallouts(): void {
    if (this.calloutButtons.size === 0) {
      if (this.leaderSvg.childNodes.length > 0) this.leaderSvg.replaceChildren();
      return;
    }
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.leaderSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.leaderSvg.replaceChildren();
    if (this.interacting) return;
    const fans: Array<[number, number]> = [
      [34, -40],
      [-48, -16],
      [40, 26],
      [-36, 34],
      [12, -58],
      [52, 8],
    ];
    let fan = 0;
    const place = (id: string, anchor: THREE.Vector3, text: string) => {
      const button = this.calloutButtons.get(id);
      if (!button) return;
      button.textContent = text;
      const ndc = anchor.clone().project(this.camera);
      if (ndc.z > 1) {
        button.hidden = true;
        return;
      }
      button.hidden = false;
      const x = (ndc.x * 0.5 + 0.5) * width;
      const y = (-ndc.y * 0.5 + 0.5) * height;
      const shift = fans[fan % fans.length] ?? [28, -28];
      fan += 1;
      let left = x + shift[0];
      let top = y + shift[1];
      if (left > width - 96) left = x - Math.abs(shift[0]);
      top = Math.max(8, Math.min(height - 28, top));
      left = Math.max(8, Math.min(width - 8, left));
      button.style.left = `${left}px`;
      button.style.top = `${top}px`;
      if (left < x) button.style.transform = 'translate(-100%, -50%)';
      else button.style.transform = 'translate(0, -50%)';
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(x));
      line.setAttribute('y1', String(y));
      line.setAttribute('x2', String(left < x ? left : left));
      line.setAttribute('y2', String(top));
      line.setAttribute('stroke', OUTLINE);
      line.setAttribute('stroke-width', '1');
      this.leaderSvg.append(line);
    };
    if (this.selected && this.calloutButtons.has(this.selected)) {
      const record = this.records.get(this.selected);
      if (record?.object.visible) {
        const center = this.centers.get(this.selected);
        if (center) place(this.selected, center, record.label);
      }
    }
    if (this.marker?.visible && this.markerLabel) {
      place('marker', this.marker.getWorldPosition(new THREE.Vector3()), this.markerLabel);
    }
  }

  loadUpperBody(urls: { skull: string; auricle: string; skin?: string }, eacMm: Vec3): Promise<void> {
    this.eacMm = eacMm;
    const center = new THREE.Vector3(eacMm[0] + this.offset[0], eacMm[1] + this.offset[1], eacMm[2] + this.offset[2]);
    this.cutCenter.copy(center);
    const adopt = (gltf: { scene: THREE.Object3D }, kind: 'skull' | 'auricle' | 'skin') => {
      const found: THREE.Mesh[] = [];
      gltf.scene.traverse((obj) => {
        if (isMesh(obj)) found.push(obj);
      });
      const mesh = found[0];
      if (!mesh) return;
      const id = kind === 'auricle' ? 'upper-body' : kind === 'skin' ? 'skin' : 'skull-layer';
      const cutScale = kind === 'skull' ? 0.98 : kind === 'auricle' ? 0.22 : 1;
      mesh.material = this.makeEntryMaterial(id, kind === 'auricle' ? '#E7A888' : kind === 'skin' ? '#E7A888' : '#F6D9A4', cutScale, kind === 'skull');
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
      mesh.userData.structureId = id;
      mesh.userData.kind = 'structure';
      mesh.userData.cutScale = cutScale;
      mesh.renderOrder = kind === 'skin' ? 3 : kind === 'auricle' ? 2 : 1;
      this.pickables.push(mesh);
      this.world.add(mesh);
      const triangles = mesh.geometry.index ? mesh.geometry.index.count / 3 : (mesh.geometry.getAttribute('position')?.count ?? 0) / 3;
      if (this.hullsOn && kind !== 'skin' && triangles > 0 && triangles < 40000) {
        const hull = new THREE.Mesh(mesh.geometry, this.hullFor(cutScale));
        hull.userData.kind = 'hull';
        hull.renderOrder = 4;
        hull.visible = this.style === 'atlas';
        mesh.add(hull);
      }
      if (kind === 'auricle') this.upperBody = mesh;
      else if (kind === 'skin') this.skinMesh = mesh;
      else this.skullLayer = mesh;
    };
    const loads: Promise<{ scene: THREE.Object3D }>[] = [this.loader.loadAsync(urls.skull), this.loader.loadAsync(urls.auricle)];
    if (urls.skin) loads.push(this.loader.loadAsync(urls.skin));
    return Promise.all(loads).then(([skull, auricle, skin]) => {
      adopt(skull, 'skull');
      adopt(auricle, 'auricle');
      if (skin) adopt(skin, 'skin');
      const hotspot = new THREE.Mesh(
        new THREE.SphereGeometry(14, 16, 12),
        new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true, opacity: 0 }),
      );
      hotspot.position.set(eacMm[0], eacMm[1], eacMm[2]);
      hotspot.userData.structureId = 'ear-hotspot';
      hotspot.userData.kind = 'structure';
      hotspot.matrixAutoUpdate = false;
      hotspot.updateMatrix();
      this.pickables.push(hotspot);
      this.world.add(hotspot);
      this.earHotspot = hotspot;
      this.setCutaway(this.lastCutRadius, this.lastSkinOpacity);
      this.invalidate();
    });
  }

  setCutaway(radiusMm: number, _skinOpacity = 1): void {
    this.distanceRadius = radiusMm;
    this.lastCutRadius = radiusMm;
    this.lastSkinOpacity = 1;
    this.cutRadius.value = Math.max(radiusMm, this.focusRadius);
    this.applyShellVisibility();
    if (this.earHotspot) this.earHotspot.visible = this.cutRadius.value < 8;
    this.invalidate();
  }

  /** Open the bone around a selected structure, in world space. */
  private focusCut(id: string | null): void {
    if (!id || id === 'bone') {
      this.focusRadius = 0;
      if (this.eacMm) {
        this.cutCenter.set(this.eacMm[0] + this.offset[0], this.eacMm[1] + this.offset[1], this.eacMm[2] + this.offset[2]);
      }
    } else {
      const box = new THREE.Box3();
      for (const itemId of [id, ...this.descendantIds(id)]) {
        const record = this.records.get(itemId);
        if (!record || record.aggregate) continue;
        const visible = record.object.visible;
        record.object.visible = true;
        box.expandByObject(record.object);
        record.object.visible = visible;
      }
      if (!box.isEmpty()) {
        box.getCenter(this.cutCenter);
        const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
        this.focusRadius = Math.min(38, Math.max(18, radius * 2.2));
      }
    }
    this.cutRadius.value = Math.max(this.distanceRadius, this.focusRadius);
    this.applyShellVisibility();
  }

  private applyShellVisibility(): void {
    const open = this.shellForced ?? this.cutRadius.value > 8;
    if (this.skinMesh) this.skinMesh.visible = !open;
    if (this.upperBody) this.upperBody.visible = !open;
    // The skull sits inside the skin. Its outline shows through the occiput crease, so it stays hidden.
    if (this.skullLayer) this.skullLayer.visible = false;
    this.paintAuricle(open);
  }

  renderStyle(): RenderStyle {
    return this.style;
  }

  setRenderStyle(style: RenderStyle): void {
    this.style = style;
    this.scene.background = new THREE.Color(style === 'atlas' ? ATLAS_BACKGROUND : MODEL_BACKGROUND);
    for (const record of this.records.values()) {
      record.materials.forEach((material) => material.dispose());
      record.materials = record.meshes.map((mesh) => {
        const material = this.makeStructureMaterial(record.id, record.color, record.opacity, record.side);
        mesh.material = material;
        return material;
      });
    }
    for (const mesh of [this.skinMesh, this.skullLayer, this.upperBody]) {
      if (!mesh) continue;
      const previous = mesh.material;
      if (!Array.isArray(previous)) previous.dispose();
      const id = String(mesh.userData.structureId ?? 'bone');
      const cutScale = Number(mesh.userData.cutScale ?? 0);
      const base = id === 'skull-layer' ? '#F6D9A4' : '#E7A888';
      mesh.material = this.makeEntryMaterial(id, base, cutScale, id === 'skull-layer');
    }
    this.refreshLook();
    this.setCutaway(this.lastCutRadius, this.lastSkinOpacity);
  }

  setRegistrationOverlay(pairs: RegistrationPair[]): void {
    if (this.registrationGroup) {
      this.world.remove(this.registrationGroup);
      this.registrationGroup.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose();
      });
      this.registrationGroup = null;
    }
    if (!pairs.length) return;
    const group = new THREE.Group();
    group.name = 'registration';
    const zetaMaterial = new THREE.MeshBasicMaterial({ color: '#8C2F1B', depthTest: false });
    const skullMaterial = new THREE.MeshBasicMaterial({ color: '#1D4E89', depthTest: false });
    const positions: number[] = [];
    for (const pair of pairs) {
      const zeta = new THREE.Mesh(new THREE.SphereGeometry(1.15, 12, 8), zetaMaterial);
      zeta.position.set(pair.zetaMm[0], pair.zetaMm[1], pair.zetaMm[2]);
      zeta.renderOrder = 60;
      const skull = new THREE.Mesh(new THREE.SphereGeometry(1.15, 12, 8), skullMaterial);
      skull.position.set(pair.skullMm[0], pair.skullMm[1], pair.skullMm[2]);
      skull.renderOrder = 60;
      group.add(zeta, skull);
      positions.push(pair.zetaMm[0], pair.zetaMm[1], pair.zetaMm[2], pair.skullMm[0], pair.skullMm[1], pair.skullMm[2]);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: '#241810', depthTest: false }));
    lines.renderOrder = 59;
    group.add(lines);
    this.world.add(group);
    this.registrationGroup = group;
  }

  private makeStructureMaterial(id: string, color: string, opacity: number, side: THREE.Side): THREE.Material {
    if (this.style === 'atlas') {
      return createAtlasMaterial({
        ramp: illustrationRamp(id, color),
        opacity,
        cut: { center: { value: this.cutCenter }, radius: this.cutRadius },
        cutScale: cutScaleFor(id),
        clippingPlanes: this.planesFor(id),
        side,
        detail: atlasDetail(id),
      });
    }
    return new THREE.MeshStandardMaterial({
      color,
      roughness: 0.48,
      metalness: 0.04,
      side,
      clippingPlanes: this.planesFor(id),
      opacity,
      transparent: opacity < 0.98,
    });
  }

  private hullFor(cutScale: number): THREE.ShaderMaterial {
    const material = this.hullMaterial.clone();
    material.uniforms.uCutCenter = { value: this.cutCenter };
    material.uniforms.uCutRadius = this.cutRadius;
    material.uniforms.uCutScale = { value: cutScale };
    material.uniforms.uResolution = this.hullMaterial.uniforms.uResolution;
    return material;
  }

  private paintAuricle(peeled: boolean): void {
    if (!this.upperBody) return;
    const material = this.upperBody.material;
    if (Array.isArray(material)) return;
    if (material instanceof THREE.ShaderMaterial && material.uniforms.uLit) {
      paintAtlas(material, illustrationRamp(peeled ? 'auricle' : 'skin', peeled ? '#C5D0D4' : '#E7A888'), 1, false);
    } else if (material instanceof THREE.MeshStandardMaterial) {
      material.color.set(peeled ? '#C5D0D4' : '#E7A888');
    }
  }

  private makeEntryMaterial(id: string, color: string, cutScale: number, reveal = false): THREE.Material {
    const side = id === 'skull-layer' || id === 'bone' ? THREE.DoubleSide : THREE.FrontSide;
    if (this.style === 'atlas') {
      const material = createAtlasMaterial({
        ramp: illustrationRamp(id, color),
        opacity: 1,
        cut: { center: { value: this.cutCenter }, radius: this.cutRadius },
        cutScale,
        clippingPlanes: id === 'bone' || id === 'sinus-dura' ? this.clipping : this.freeClip,
        side,
        detail: atlasDetail(id),
        reveal,
      });
      if (id === 'skin') {
        material.polygonOffset = true;
        material.polygonOffsetFactor = -2;
        material.polygonOffsetUnits = -2;
        material.uniforms.uRim.value = 0;
      }
      return material;
    }
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: id === 'skin' ? 0.62 : 0.58,
      metalness: 0.02,
      transparent: false,
      side,
    });
    if (id === 'skin') {
      material.polygonOffset = true;
      material.polygonOffsetFactor = -2;
      material.polygonOffsetUnits = -2;
    }
    const radius = this.cutRadius;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uCutCenter = { value: this.cutCenter };
      shader.uniforms.uCutRadius = radius;
      shader.uniforms.uCutScale = { value: cutScale };
      shader.uniforms.uReveal = { value: reveal ? 1 : 0 };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vEntWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvEntWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vEntWorld;\nuniform vec3 uCutCenter;\nuniform float uCutRadius;\nuniform float uCutScale;\nuniform float uReveal;')
        .replace(
          '#include <dithering_fragment>',
          `float entDist = distance(vEntWorld, uCutCenter);
          if (uReveal > 0.5) {
            if (uCutRadius < 1.0 || entDist > uCutRadius * max(uCutScale, 0.01)) discard;
          } else if (uCutScale > 0.0 && uCutRadius > 0.0 && entDist < uCutRadius * uCutScale) discard;
          #include <dithering_fragment>`,
        );
    };
    material.customProgramCacheKey = () => `ent3d-cut-${id}-${cutScale}-${reveal ? 1 : 0}`;
    return material;
  }

  private paintEntry(mesh: THREE.Mesh, opacity: number): void {
    const material = mesh.material;
    if (Array.isArray(material)) return;
    material.opacity = opacity;
    material.transparent = opacity < 0.98;
    material.depthWrite = opacity >= 0.55;
    if (material instanceof THREE.ShaderMaterial && material.uniforms.uOpacity) material.uniforms.uOpacity.value = opacity;
    const hull = mesh.children.find((child) => child.userData.kind === 'hull');
    if (hull) hull.visible = this.style === 'atlas' && this.hullsOn && opacity > 0.25 && mesh.visible;
  }

  /** Hide the head when the cut discards it or it leaves the camera frustum. */
  private cullContextMeshes(): void {
    this.camera.updateMatrixWorld();
    if (this.shellForced === true) {
      if (this.upperBody) this.upperBody.visible = false;
      if (this.skinMesh) this.skinMesh.visible = false;
      return;
    }
    this.cullContext(this.upperBody, this.cutRadius.value);
  }

  private cullContext(mesh: THREE.Mesh | null, limit: number): void {
    if (!mesh) return;
    // Bone, inner-ear, and dissection views force the shell closed. The per-frame
    // cull used to turn the auricle back on whenever the spherical cut was shut.
    if (this.shellForced === true || this.cutRadius.value > 8) {
      mesh.visible = false;
      return;
    }
    const material = mesh.material as THREE.MeshStandardMaterial;
    if (material.opacity <= 0.02 || this.meshInsideCut(mesh, limit) || this.outsideFrustum(mesh)) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
  }

  private meshInsideCut(mesh: THREE.Mesh, radius: number): boolean {
    if (!(radius > 0)) return false;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox;
    if (!box) return false;
    mesh.updateWorldMatrix(true, false);
    const corners: [number, number, number][] = [];
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          this.cornerScratch.set(x, y, z).applyMatrix4(mesh.matrixWorld);
          corners.push([this.cornerScratch.x, this.cornerScratch.y, this.cornerScratch.z]);
        }
      }
    }
    return coveredBySphere(corners, [this.cutCenter.x, this.cutCenter.y, this.cutCenter.z], radius);
  }

  private outsideFrustum(mesh: THREE.Mesh): boolean {
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    const sphere = mesh.geometry.boundingSphere;
    if (!sphere) return false;
    mesh.updateWorldMatrix(true, false);
    this.frustumMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.frustumMatrix);
    this.sphereScratch.copy(sphere).applyMatrix4(mesh.matrixWorld);
    return !this.frustum.intersectsSphere(this.sphereScratch);
  }

  private projectStudyLabels(now: number): void {
    if (!this.studyLayer) return;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const due = this.labelPlanAt === 0 || now - this.labelPlanAt > 100;
    if (!this.interacting && due) {
      this.labelPlanAt = now;
      this.labelPlan = this.layoutStudyLabels(width, height).map((item) =>
        this.phoneLayout() && item.id === this.selected ? { ...item, mode: 'label' as const } : item,
      );
      this.rememberOffsets(width, height);
    }
    const wanted = new Set(this.labelPlan.map((item) => item.id));
    for (const [id, button] of this.studyButtons) {
      if (!wanted.has(id)) {
        button.remove();
        this.studyButtons.delete(id);
        this.leaderLines.get(id)?.remove();
        this.leaderLines.delete(id);
      }
    }
    const svg = this.ensureStudySvg(width, height);
    svg.style.display = this.interacting ? 'none' : '';
    for (const item of this.labelPlan) {
      const source = this.labelById.get(item.id);
      const priority = source?.priority ?? 0;
      const secondary = item.id !== this.selected && (item.mode === 'dot' || priority < 40);
      let button = this.studyButtons.get(item.id);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.style.left = '0';
        button.style.top = '0';
        button.dataset.labelId = item.id;
        button.addEventListener('click', (event) => {
          event.preventDefault();
          this.onLabelHandler?.(item.id);
        });
        this.studyLayer.append(button);
        this.studyButtons.set(item.id, button);
      }
      const conceal = this.interacting && secondary;
      button.hidden = false;
      button.style.visibility = conceal ? 'hidden' : '';
      if (conceal) {
        const hiddenLine = this.leaderLines.get(item.id);
        if (hiddenLine) hiddenLine.style.display = 'none';
      }
      const modeClass = item.mode === 'dot' ? 'study-dot' : 'study-label';
      if (button.className !== modeClass) button.className = modeClass;
      const caption = source ? `${item.mode}|${source.en}|${source.ko}` : item.mode;
      const accessible = source ? `${source.en}${source.ko ? ` ${source.ko}` : ''}` : item.id;
      if (button.getAttribute('aria-label') !== accessible) button.setAttribute('aria-label', accessible);
      if (button.dataset.caption !== caption) {
        button.dataset.caption = caption;
        button.replaceChildren();
        if (item.mode === 'label' && source) {
          const english = document.createElement('span');
          english.className = 'study-en';
          english.textContent = source.en || source.text;
          button.append(english);
          if (source.ko) {
            const korean = document.createElement('span');
            korean.className = 'study-ko';
            korean.textContent = source.ko;
            button.append(korean);
          }
        }
      }
      const offset = this.labelOffset.get(item.id) ?? { ox: 0, oy: 0 };
      const anchor = source ? this.projectSpecimen(source.position, width, height) : null;
      const behind = !anchor || anchor.behind;
      const x = anchor && !anchor.behind ? anchor.x + offset.ox : item.x;
      const y = anchor && !anchor.behind ? anchor.y + offset.oy : item.y;
      button.hidden = behind;
      if (behind) continue;
      const shift = item.mode === 'dot' ? ' translate(-50%, -50%)' : '';
      button.style.transform = `translate3d(${x}px, ${y}px, 0)${shift}`;
      const opacity = item.dimmed ? '0.38' : '1';
      if (button.style.opacity !== opacity) button.style.opacity = opacity;
      if (item.mode !== 'label' || !anchor) {
        const hiddenLine = this.leaderLines.get(item.id);
        if (hiddenLine) hiddenLine.style.display = 'none';
        continue;
      }
      let line = this.leaderLines.get(item.id);
      if (!line) {
        line = document.createElementNS(SVG_NS, 'line') as SVGLineElement;
        line.setAttribute('stroke', '#222');
        line.setAttribute('stroke-width', '1');
        svg.append(line);
        this.leaderLines.set(item.id, line);
      }
      line.style.display = this.interacting ? 'none' : '';
      if (this.interacting) continue;
      line.setAttribute('x1', String(anchor.x));
      line.setAttribute('y1', String(anchor.y));
      line.setAttribute('x2', String(x));
      line.setAttribute('y2', String(y + 8));
    }
  }

  private ensureStudySvg(width: number, height: number): SVGSVGElement {
    if (!this.studySvg) {
      const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
      svg.classList.add('leaders');
      this.studyLayer?.append(svg);
      this.studySvg = svg;
    }
    const view = `0 0 ${width} ${height}`;
    if (this.studySvg.getAttribute('viewBox') !== view) this.studySvg.setAttribute('viewBox', view);
    return this.studySvg;
  }

  private rememberOffsets(width: number, height: number): void {
    for (const item of this.labelPlan) {
      const source = this.labelById.get(item.id);
      if (!source) continue;
      const anchor = this.projectSpecimen(source.position, width, height);
      if (!anchor || anchor.behind) {
        this.labelOffset.set(item.id, { ox: 0, oy: 0 });
        continue;
      }
      this.labelOffset.set(item.id, { ox: item.x - anchor.x, oy: item.y - anchor.y });
    }
  }

  private layoutStudyLabels(width: number, height: number): Placement[] {
    this.rebuildOccluders();
    const distance = this.cameraDistance();
    const inset = this.labelInset;
    const parts = focusPartList(this.selected);
    if (this.viewStage === 'inner' && this.labelMode === 'basic' && !this.viewStep && !parts) {
      const column = [];
      for (const id of INNER_CORE) {
        const label = this.studyLabels.find((item) => item.id === id);
        if (!label) continue;
        const anchor = this.projectSpecimen(label.position, width, height);
        if (!anchor || anchor.behind) continue;
        const size = this.labelSize(label.en || label.text, Boolean(label.ko));
        column.push({
          id: label.id,
          anchorX: anchor.x,
          anchorY: anchor.y,
          width: size.width,
          height: size.height,
          priority: label.priority,
        });
      }
      if (column.length) return columnPlacements(column, width, height, inset);
    }
    if (parts && !this.viewStep) {
      const column = [];
      for (const label of this.studyLabels) {
        if (!parts.includes(label.id)) continue;
        const anchor = this.projectSpecimen(label.position, width, height);
        if (!anchor || anchor.behind) continue;
        const size = this.labelSize(label.en || label.text, Boolean(label.ko));
        column.push({
          id: label.id,
          anchorX: anchor.x,
          anchorY: anchor.y,
          width: size.width,
          height: size.height,
          priority: label.priority,
        });
      }
      if (column.length) return columnPlacements(column, width, height, inset);
    }
    const chosenAll = chooseStudyLabels(this.studyLabels, this.labelMode, distance, this.selected, this.viewStage, this.viewStep);
    const chosen = this.phoneLayout() ? thinForPhone(chosenAll, distance, this.selected) : chosenAll;
    if (this.viewStep) {
      const column = [];
      for (const label of chosen) {
        if (!label.steps?.includes(this.viewStep)) continue;
        if (label.tier !== 'subpart') {
          const owner = this.records.get(label.id);
          if (owner && !owner.object.visible) continue;
        }
        const anchor = this.projectSpecimen(label.position, width, height);
        if (!anchor || anchor.behind) continue;
        const size = this.labelSize(label.en || label.text, Boolean(label.ko));
        column.push({
          id: label.id,
          anchorX: anchor.x,
          anchorY: anchor.y,
          width: size.width,
          height: size.height,
          priority: label.priority,
        });
      }
      if (column.length) return columnPlacements(column, width, height, inset);
    }
    const inputs = [];
    for (const label of chosen) {
      if (!this.phoneLayout() && label.id === 'tm-pars-flaccida') continue;
      if (label.tier !== 'subpart') {
        const owner = this.records.get(label.id);
        if (owner && !owner.object.visible) continue;
      }
      if (label.tier === 'surface' && (this.shellForced || this.cutRadius.value > 8) && this.viewStage !== 'body' && this.viewStage !== 'ear') continue;
      const anchor = this.projectSpecimen(label.position, width, height);
      if (!anchor || anchor.behind) continue;
      const size = this.labelSize(label.en || label.text, Boolean(label.ko));
      const occluded = this.anchorOccluded(label.position);
      let priority = label.priority;
      if (label.id === this.selected) priority += 40;
      if (label.parentId === this.selected) priority += 80;
      if (this.viewStep && label.steps?.includes(this.viewStep)) priority += 50;
      inputs.push({
        id: label.id,
        priority,
        anchorX: anchor.x,
        anchorY: anchor.y,
        width: size.width,
        height: size.height,
        occluded,
      });
    }
    const allowDots = this.viewStage !== 'body' && this.viewStage !== 'ear';
    return placeLabels(inputs, width, height, inset, { allowDots });
  }

  private projectSpecimen(position: Vec3, width: number, height: number): { x: number; y: number; behind: boolean } | null {
    this.worldScratch.set(position[0] + this.offset[0], position[1] + this.offset[1], position[2] + this.offset[2]);
    this.ndc.copy(this.worldScratch).project(this.camera);
    if (this.ndc.z > 1) return { x: 0, y: 0, behind: true };
    return { x: (this.ndc.x * 0.5 + 0.5) * width, y: (-this.ndc.y * 0.5 + 0.5) * height, behind: false };
  }

  /** Opaque, visible meshes only. The transparent bone used to be tested and then ignored. */
  private rebuildOccluders(): void {
    const meshes: THREE.Object3D[] = [];
    for (const record of this.records.values()) {
      if (!record.object.visible || record.aggregate) continue;
      const opacity = record.materials[0]?.opacity ?? 1;
      if (opacity < 0.45) continue;
      for (const mesh of record.meshes) meshes.push(mesh);
    }
    if (this.skullLayer?.visible) {
      const opacity = (this.skullLayer.material as THREE.MeshStandardMaterial).opacity;
      if (opacity >= 0.45) meshes.push(this.skullLayer);
    }
    if (this.skinMesh?.visible) {
      const opacity = (this.skinMesh.material as THREE.Material).opacity ?? 1;
      if (opacity >= 0.45) meshes.push(this.skinMesh);
    }
    if (this.upperBody?.visible && this.cutRadius.value <= 5) {
      const opacity = (this.upperBody.material as THREE.MeshStandardMaterial).opacity;
      if (opacity >= 0.45) meshes.push(this.upperBody);
    }
    this.occluders = meshes;
  }

  private anchorOccluded(position: Vec3): boolean {
    if (this.occluders.length === 0) return false;
    this.rayTarget.set(position[0] + this.offset[0], position[1] + this.offset[1], position[2] + this.offset[2]);
    this.rayDir.copy(this.rayTarget).sub(this.camera.position);
    const length = this.rayDir.length();
    if (length < 0.5) return false;
    this.rayDir.multiplyScalar(1 / length);
    this.raycaster.near = 0;
    this.raycaster.far = Math.max(0.01, length - 0.8);
    this.raycaster.set(this.camera.position, this.rayDir);
    const hits = this.raycaster.intersectObjects(this.occluders, false);
    return hits.some((hit) => isShown(hit.object));
  }

  private projectGizmo(): void {
    this.camera.getWorldDirection(this.rayDir);
    this.gizmoCam.position.copy(this.rayDir.multiplyScalar(-4));
    this.gizmoCam.up.copy(this.camera.up);
    this.gizmoCam.lookAt(0, 0, 0);
    this.gizmoCam.updateMatrixWorld();
    const project = (x: number, y: number, z: number) => {
      this.ndc.set(x, y, z).project(this.gizmoCam);
      return { x: (this.ndc.x * 0.5 + 0.5) * 84, y: (-this.ndc.y * 0.5 + 0.5) * 84 };
    };
    const origin = project(0, 0, 0);
    for (const axis of GIZMO_AXES) {
      const tip = project(axis.dir[0] * 1.05, axis.dir[1] * 1.05, axis.dir[2] * 1.05);
      const collapsed = Math.hypot(tip.x - origin.x, tip.y - origin.y) < 10;
      let line = this.gizmoLines.get(axis.id);
      if (!line) {
        line = document.createElementNS(SVG_NS, 'line') as SVGLineElement;
        line.setAttribute('stroke', '#222');
        line.setAttribute('stroke-width', '1.25');
        this.gizmoSvg.append(line);
        this.gizmoLines.set(axis.id, line);
      }
      line.style.display = collapsed ? 'none' : '';
      if (!collapsed) {
        line.setAttribute('x1', String(origin.x));
        line.setAttribute('y1', String(origin.y));
        line.setAttribute('x2', String(tip.x));
        line.setAttribute('y2', String(tip.y));
      }
      const label = this.gizmo.querySelector<HTMLElement>(`[data-axis="${axis.id}"]`);
      if (!label) continue;
      const textPos = project(axis.dir[0] * 1.35, axis.dir[1] * 1.35, axis.dir[2] * 1.35);
      const separated = !collapsed && Math.hypot(textPos.x - origin.x, textPos.y - origin.y) > 16;
      label.hidden = !separated;
      if (!separated) continue;
      if (!label.dataset.placed) {
        label.style.left = '0';
        label.style.top = '0';
        label.dataset.placed = '1';
      }
      label.style.transform = `translate3d(${textPos.x}px, ${textPos.y}px, 0) translate(-50%, -50%)`;
    }
  }

  /** Pixels from the finger to each study anchor. Region dots are not structures. */
  private anchorScreenPx(clientX: number, clientY: number): Map<string, number> {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const rect = this.canvas.getBoundingClientRect();
    const shown = new Set(
      [...this.studyButtons.values()]
        .filter((button) => button.classList.contains('study-label') && !button.hidden)
        .map((button) => button.dataset.labelId),
    );
    const distances = new Map<string, number>();
    for (const label of this.studyLabels) {
      if (!shown.has(label.id)) continue;
      const anchor = this.projectSpecimen(label.position, width, height);
      if (!anchor || anchor.behind) continue;
      const dist = Math.hypot(clientX - rect.left - anchor.x, clientY - rect.top - anchor.y);
      distances.set(label.id, dist);
      if (label.id === 'cochlea') {
        for (const part of COCHLEA_PARTS) distances.set(part, dist);
      }
    }
    return distances;
  }

  private labelAt(clientX: number, clientY: number): string | null {
    const buttons = [...this.studyButtons.values(), ...this.calloutButtons.values()];
    const hits: { id: string; inside: boolean; area: number; dist: number; dot: boolean }[] = [];
    const minHit = this.canvas.clientWidth < 960 ? 44 : 0;
    for (const button of buttons) {
      if (button.hidden) continue;
      const rect = button.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      const id = button.dataset.labelId;
      if (!id) continue;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const inside = Math.abs(clientX - cx) <= rect.width / 2 && Math.abs(clientY - cy) <= rect.height / 2;
      const padded =
        Math.abs(clientX - cx) <= Math.max(rect.width, minHit) / 2 &&
        Math.abs(clientY - cy) <= Math.max(rect.height, minHit) / 2;
      if (!inside && !padded) continue;
      hits.push({
        id,
        inside,
        area: rect.width * rect.height,
        dist: Math.hypot(clientX - cx, clientY - cy),
        dot: button.classList.contains('study-dot'),
      });
    }
    const dotHit = hits.filter((hit) => hit.dot && hit.inside).sort((a, b) => a.dist - b.dist)[0];
    if (dotHit) return dotHit.id;
    const visual = hits.filter((hit) => hit.inside).sort((a, b) => a.area - b.area || a.dist - b.dist);
    if (visual[0]) return visual[0].id;
    hits.sort((a, b) => a.dist - b.dist);
    return hits[0]?.id ?? null;
  }

  private phoneLayout(): boolean {
    return usesPhoneLabelLayout(window.innerWidth);
  }

  private labelSize(text: string, twoLines: boolean): { width: number; height: number } {
    const size = estimateLabelSize(text, twoLines);
    if (!this.phoneLayout()) return size;
    return { width: Math.max(size.width, 88), height: Math.max(twoLines ? 48 : 44, size.height) };
  }

  private applyViewOffset(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (!this.visibleRect || width < 2 || height < 2) {
      this.camera.clearViewOffset();
      return;
    }
    const offset = viewOffsetFor(width, height, this.visibleRect);
    this.camera.setViewOffset(offset.fullWidth, offset.fullHeight, offset.x, offset.y, offset.width, offset.height);
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const now = performance.now();
    if (!this.zoomGesture || now > this.gestureUntil + 40) this.beginZoomAt(event.clientX, event.clientY);
    if (!this.zoomGesture) return;
    const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * this.canvas.clientHeight : event.deltaY;
    this.zoomGesture.scale *= Math.exp(pixels * 0.0015);
    this.applyZoomScale(this.zoomGesture.scale);
    this.gestureUntil = now + 220;
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') this.lastTouchAt = performance.now();
    if (this.syntheticMouse(event)) return;
    this.down = { x: event.clientX, y: event.clientY };
  };

  /** Chrome's touch emulation follows a touch with a mouse pointer that would clear the tap. */
  private syntheticMouse(event: PointerEvent): boolean {
    return event.pointerType === 'mouse' && performance.now() - this.lastTouchAt < 700;
  }

  private onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length < 2) return;
    event.preventDefault();
    this.pinching = true;
    this.suppressTap = true;
    this.clearOrbitInertia();
    if (this.pendingTap) window.clearTimeout(this.pendingTap);
    this.pendingTap = 0;
    const a = event.touches[0]!;
    const b = event.touches[1]!;
    this.pinchStart = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
    this.beginZoomAt((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
  };

  private onTouchMove = (event: TouchEvent): void => {
    if (!this.pinching || event.touches.length < 2 || !this.zoomGesture) return;
    event.preventDefault();
    const a = event.touches[0]!;
    const b = event.touches[1]!;
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
    this.applyZoomScale(this.pinchStart / dist);
  };

  private onTouchEnd = (event: TouchEvent): void => {
    if (event.touches.length >= 2) return;
    const wasPinch = this.pinching;
    if (this.pinching) this.zoomGesture = null;
    this.pinching = false;
    if (wasPinch && event.touches.length === 1) {
      this.clearOrbitInertia();
      this.hasDragOffset = false;
    }
    if (event.touches.length === 0) this.suppressTap = false;
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.syntheticMouse(event)) return;
    if (!this.down) return;
    const moved = Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y);
    this.down = null;
    if (this.pinching || this.suppressTap) return;
    if (moved > 10) return;
    const now = event.timeStamp || performance.now();
    const gap = now - this.lastTapAt;
    const sameSpot = Math.hypot(event.clientX - this.lastTapX, event.clientY - this.lastTapY) < 28;
    this.lastTapAt = now;
    this.lastTapX = event.clientX;
    this.lastTapY = event.clientY;
    if (gap >= 40 && gap < 1200 && sameSpot && this.lastPick && this.mode === 'view') {
      const picked = this.lastPick;
      this.lastPick = null;
      this.onDoubleHandler?.(picked);
      return;
    }
    const labelId = this.labelAt(event.clientX, event.clientY);
    if (labelId) {
      this.lastPick = null;
      this.onLabelHandler?.(labelId === 'marker' ? '' : labelId);
      return;
    }
    if (event.shiftKey) {
      const hit = this.cast(event.clientX, event.clientY);
      if (hit) this.onShiftHandler?.(hit.pointMm);
      return;
    }
    const hit = this.cast(event.clientX, event.clientY);
    if (this.mode === 'measure') {
      if (!hit || hit.kind !== 'structure') return;
      if (this.points.length >= 2) this.points = [];
      this.points.push(hit.pointMm);
      this.redrawMeasurement();
      this.onMeasureHandler?.(this.measurementPoints());
      return;
    }
    this.lastPick = hit;
    this.onPickHandler?.(hit);
  };

  private rememberAnchor(anchor: THREE.Vector3, stop: number): void {
    this.lastAnchor = anchor.clone();
    this.outward.copy(this.camera.position).sub(anchor);
    if (this.outward.lengthSq() < 1e-6) this.outward.set(0, 0, 1);
    else this.outward.normalize();
    this.lastStop = stop;
  }

  /**
   * OrbitControls stops updating pointer positions while it is disabled.
   * A pinch used to do that, so lifting back to one finger restarted the
   * drag from where the finger was when the second finger landed. The next
   * move then applied the whole missed distance in one frame.
   * Keep controls enabled, and drop any leftover flick when the finger count changes.
   */
  private clearOrbitInertia(): void {
    const controls = this.controls as OrbitControls & { _sphericalDelta: { set: (theta: number, phi: number, radius: number) => void } };
    controls._sphericalDelta.set(0, 0, 0);
  }

  /** A single frame of a finger drag cannot spin the model. Tweens are left alone. */
  private limitDragStep(): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    if (offset.lengthSq() < 1e-8) return;
    const dragging = this.pointerDown && !this.tween;
    if (!dragging || !this.hasDragOffset) {
      this.dragOffset.copy(offset);
      this.hasDragOffset = true;
      return;
    }
    const angle = this.dragOffset.angleTo(offset);
    if (angle > MAX_DRAG_STEP_RAD && angle < Math.PI - 1e-3) {
      const swing = new THREE.Quaternion().setFromUnitVectors(this.dragOffset.clone().normalize(), offset.clone().normalize());
      swing.slerp(new THREE.Quaternion(), 1 - MAX_DRAG_STEP_RAD / angle);
      const kept = this.dragOffset.clone().applyQuaternion(swing).setLength(offset.length());
      this.applyingZoom = true;
      this.camera.position.copy(this.controls.target).add(kept);
      this.camera.lookAt(this.controls.target);
      this.applyingZoom = false;
      this.clearOrbitInertia();
      this.dragOffset.copy(kept);
      return;
    }
    this.dragOffset.copy(offset);
  }

  /** Rotation stays outside the last zoomed surface instead of swinging into it. */
  private guardOrbit(): void {
    if (this.applyingZoom || this.tween || !this.lastAnchor || this.outward.lengthSq() < 1e-6) return;
    const anchor = this.lastAnchor;
    const held = holdOrbit({
      camera: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
      anchor: [anchor.x, anchor.y, anchor.z],
      outward: [this.outward.x, this.outward.y, this.outward.z],
      minDistance: this.distanceLimits.min,
      stopDistance: this.distanceLimits.min,
    });
    if (!held.held && !this.cameraBuried()) return;
    this.applyingZoom = true;
    if (!held.held) {
      const stop = this.distanceLimits.min;
      if (this.camera.position.distanceTo(anchor) >= stop - 0.05) {
        this.applyingZoom = false;
        return;
      }
      this.camera.position.copy(anchor).addScaledVector(this.outward, stop);
      this.controls.target.copy(anchor);
    } else {
      const desired: [number, number, number] = [
        held.camera[0] - held.target[0],
        held.camera[1] - held.target[1],
        held.camera[2] - held.target[2],
      ];
      const currentOff = this.camera.position.clone().sub(this.controls.target);
      const eased = easeOrbitOffset([currentOff.x, currentOff.y, currentOff.z], desired, MAX_HOLD_STEP_RAD);
      const turn = currentOff.angleTo(new THREE.Vector3(...desired));
      if (turn > MAX_HOLD_STEP_RAD) {
        this.camera.position.copy(this.controls.target).add(new THREE.Vector3(...eased));
      } else {
        this.camera.position.set(held.camera[0], held.camera[1], held.camera[2]);
        this.controls.target.set(held.target[0], held.target[1], held.target[2]);
      }
    }
    this.controls.update();
    this.applyingZoom = false;
  }

  /** True when the camera sits in a pocket with a wall close behind it and another in front. */
  private cameraBuried(): boolean {
    const objects: THREE.Object3D[] = [];
    for (const record of this.records.values()) {
      if (!record.object.visible || record.aggregate) continue;
      const opacity = record.materials[0]?.opacity ?? 1;
      if (opacity < 0.35) continue;
      for (const mesh of record.meshes) if (isShown(mesh)) objects.push(mesh);
    }
    for (const mesh of [this.skinMesh, this.upperBody, this.skullLayer]) {
      if (!mesh?.visible) continue;
      const opacity = (mesh.material as THREE.Material).opacity ?? 1;
      if (opacity < 0.35) continue;
      objects.push(mesh);
    }
    if (objects.length === 0) return false;
    this.camera.getWorldDirection(this.rayDir);
    const nearest = (dir: THREE.Vector3, far: number) => {
      this.raycaster.near = 0;
      this.raycaster.far = far;
      this.raycaster.set(this.camera.position, dir);
      const hit = this.raycaster.intersectObjects(objects, false).find((item) => isShown(item.object));
      return hit?.distance ?? Infinity;
    };
    const ahead = nearest(this.rayDir, 50);
    const behind = nearest(this.rayDir.clone().negate(), 16);
    return behind < 8 && ahead < 50;
  }

  private beginZoomAt(clientX: number, clientY: number): void {
    const hit = this.cursorPoint(clientX, clientY);
    const rect = this.canvas.getBoundingClientRect();
    this.tween = null;
    this.zoomGesture = {
      cam: this.camera.position.clone(),
      target: this.controls.target.clone(),
      anchor: hit ? hit.point.clone() : null,
      radius: hit?.radius ?? 0,
      scale: 1,
      at: { x: clientX - rect.left, y: clientY - rect.top },
    };
  }

  /** Shift the camera so `anchor` stays on the pinch midpoint after the dolly. */
  private pinAnchorToScreen(anchor: THREE.Vector3, at: { x: number; y: number }): void {
    const width = Math.max(this.canvas.clientWidth, 1);
    const height = Math.max(this.canvas.clientHeight, 1);
    for (let pass = 0; pass < 2; pass += 1) {
      this.ndc.copy(anchor).project(this.camera);
      const x = (this.ndc.x * 0.5 + 0.5) * width;
      const y = (-this.ndc.y * 0.5 + 0.5) * height;
      const dx = x - at.x;
      const dy = y - at.y;
      if (Math.hypot(dx, dy) < 0.6) return;
      const dist = Math.max(this.camera.position.distanceTo(anchor), 1);
      const worldPerPx = (2 * Math.tan((this.camera.fov * Math.PI) / 360) * dist) / height;
      this.camera.updateMatrixWorld();
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      const shift = right.multiplyScalar(-dx * worldPerPx).add(up.multiplyScalar(dy * worldPerPx));
      this.camera.position.add(shift);
      this.controls.target.add(shift);
      this.camera.lookAt(this.controls.target);
    }
  }

  private applyZoomScale(scale: number): void {
    const gesture = this.zoomGesture;
    if (!gesture) return;
    const stop = stopDistanceMm(gesture.radius, this.distanceLimits.min);
    const next = zoomAboutAnchor({
      camera: [gesture.cam.x, gesture.cam.y, gesture.cam.z],
      target: [gesture.target.x, gesture.target.y, gesture.target.z],
      anchor: gesture.anchor ? [gesture.anchor.x, gesture.anchor.y, gesture.anchor.z] : null,
      scale,
      minDistance: this.distanceLimits.min,
      maxDistance: this.distanceLimits.max,
      stopDistance: stop,
    });
    this.applyingZoom = true;
    this.camera.position.set(next.camera[0], next.camera[1], next.camera[2]);
    this.controls.target.set(next.target[0], next.target[1], next.target[2]);
    this.camera.lookAt(this.controls.target);
    if (this.phoneLayout() && gesture.anchor && gesture.at) this.pinAnchorToScreen(gesture.anchor, gesture.at);
    this.controls.update();
    if (this.phoneLayout() && gesture.anchor && gesture.at) this.pinAnchorToScreen(gesture.anchor, gesture.at);
    if (gesture.anchor) this.rememberAnchor(gesture.anchor, stop);
    this.applyingZoom = false;
    this.interacting = true;
    this.gestureUntil = performance.now() + 180;
    this.applyPixelRatio(true);
    this.invalidate();
  }

  /** Closest opaque surface under a screen point. Faint bone is skipped so inner structures can be the anchor. */
  private surfaceAt(clientX: number, clientY: number): { point: THREE.Vector3; id: string; radius: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const objects: THREE.Object3D[] = [];
    for (const record of this.records.values()) {
      if (!record.object.visible || record.aggregate) continue;
      const opacity = record.materials[0]?.opacity ?? 1;
      if (opacity < 0.35) continue;
      for (const mesh of record.meshes) if (isShown(mesh)) objects.push(mesh);
    }
    for (const mesh of [this.skinMesh, this.upperBody, this.skullLayer]) {
      if (!mesh?.visible) continue;
      const opacity = (mesh.material as THREE.Material).opacity ?? 1;
      if (opacity < 0.35) continue;
      objects.push(mesh);
    }
    const hits = this.raycaster.intersectObjects(objects, false).filter((hit) => isShown(hit.object));
    const hit = hits[0];
    if (!hit) return null;
    const id = String(hit.object.userData.structureId ?? hit.object.name ?? '');
    let radius = 0;
    const record = this.records.get(id);
    if (record) {
      const box = new THREE.Box3().setFromObject(record.object);
      if (!box.isEmpty()) radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    } else {
      const mesh = hit.object as THREE.Mesh;
      const sphere = mesh.geometry?.boundingSphere;
      if (sphere) radius = sphere.radius;
    }
    return { point: hit.point.clone(), id, radius: zoomStructureSize(id, radius) };
  }

  /**
   * Point that should stay under the finger. A surface hit wins. A miss uses
   * the finger ray where it crosses the orbit-target plane, so an empty pinch
   * does not slide the view toward the screen centre.
   */
  private cursorPoint(clientX: number, clientY: number): { point: THREE.Vector3; radius: number } | null {
    const hit = this.surfaceAt(clientX, clientY);
    if (hit) return { point: hit.point, radius: hit.radius };
    let nearest: { point: THREE.Vector3; radius: number; px: number } | null = null;
    for (const dx of [-16, 0, 16]) {
      for (const dy of [-16, 0, 16]) {
        if (dx === 0 && dy === 0) continue;
        const found = this.surfaceAt(clientX + dx, clientY + dy);
        if (!found) continue;
        const px = Math.hypot(dx, dy);
        if (!nearest || px < nearest.px) nearest = { point: found.point, radius: found.radius, px };
      }
    }
    if (nearest) return nearest;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.camera.getWorldDirection(this.rayDir);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.rayDir, this.controls.target);
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, point)) return null;
    return { point, radius: 0 };
  }

  private cast(clientX: number, clientY: number): PickHit | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const gathered: Gathered[] = [];
    for (const sample of touchSampleOffsets()) {
      const x = clientX + sample.x;
      const y = clientY + sample.y;
      this.pointer.x = ((x - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((y - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hits = this.raycaster.intersectObjects(this.pickables, false);
      for (const hit of hits) {
        if (!isShown(hit.object)) continue;
        const structureId = String(hit.object.userData.structureId ?? '');
        if (!structureId) continue;
        const record = this.records.get(structureId);
        const shell = isNavShell(structureId);
        if (shell && (this.viewStage === 'bone' || this.viewStage === 'inner')) continue;
        if (shell && structureId !== 'ear-hotspot') {
          const material = (hit.object as THREE.Mesh).material;
          const opacity = Array.isArray(material) ? 1 : material?.opacity ?? 1;
          if (opacity < 0.25) continue;
        }
        gathered.push({
          structureId,
          distance: hit.distance,
          size: record?.size ?? 1e6,
          central: sample.central,
          envelope: record?.envelope || shell,
          point: hit.point.clone(),
          kind: 'structure',
        });
      }
    }
    const screenPx = this.anchorScreenPx(clientX, clientY);
    for (const item of gathered) item.screenPx = screenPx.get(item.structureId);
    const cochleaPx = screenPx.get('cochlea');
    const scalaHit = gathered.some((item) => item.central && (item.structureId === 'cochlea' || item.structureId.startsWith('scala-')));
    if (cochleaPx != null && cochleaPx <= TAP_SCREEN_RADIUS_PX && !scalaHit) {
      const closest = gathered
        .filter((item) => item.central && !item.envelope && !isNavShell(item.structureId))
        .sort((a, b) => a.distance - b.distance)[0];
      gathered.push({
        structureId: 'scala-vestibuli',
        distance: (closest?.distance ?? 1) + 50,
        size: closest?.size ?? 12,
        central: true,
        envelope: false,
        screenPx: cochleaPx,
        point: closest?.point.clone() ?? this.raycaster.ray.at(1, new THREE.Vector3()),
        kind: 'structure',
      });
    }
    const chosen = chooseTap(gathered);
    if (!chosen) return null;
    const pointOf = (item: Gathered): Vec3 => {
      const local = this.world.worldToLocal(item.point.clone());
      return [local.x, local.y, local.z];
    };
    const overlaps = rankTapChoices(gathered).map((item) => {
      const gatheredHit = gathered.find((entry) => entry.structureId === item.structureId && entry.central) ?? item;
      return { structureId: item.structureId, pointMm: pointOf(gatheredHit as Gathered) };
    });
    const same = gathered.filter((item) => item.structureId === chosen.structureId);
    const central = same.filter((item) => item.central).sort((a, b) => a.distance - b.distance)[0];
    const pointHit = central ?? same.sort((a, b) => a.distance - b.distance)[0];
    if (!pointHit) return null;
    return {
      structureId: chosen.structureId,
      pointMm: pointOf(pointHit),
      kind: pointHit.kind,
      overlaps: overlaps.length > 1 ? overlaps : undefined,
    };
  }
}
