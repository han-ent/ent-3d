import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { ContourSource } from '../ct-slice';
import { displayOpacity, choosePick, isEnvelope, touchSampleOffsets, type PickCandidate } from '../picking';
import { publicUrl } from '../paths';
import type { SlicePose } from '../ct';
import { chooseScaleMm, worldClippingPlane } from '../measurement';
import type { DissectionStep, Vec3 } from '../types';
import { DEFAULT_CAMERA, DEFAULT_FOV, SELECTION_SPAN_MM } from '../view-pose';

export type PickHit = {
  structureId: string;
  pointMm: Vec3;
  kind: 'structure' | 'ct';
};

type StructureRecord = {
  id: string;
  layer: string;
  object: THREE.Object3D;
  materials: THREE.MeshStandardMaterial[];
  meshes: THREE.Mesh[];
  outlines: THREE.Mesh[];
  opacity: number;
  envelope: boolean;
  size: number;
  color: string;
  label: string;
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
const STAGE = '#C4C2BC';
const OUTLINE = '#8C2F1B';
const DIM_GRAY = '#D5D3CE';
const INTRO_LABELS = ['malleus', 'incus', 'stapes', 'facial-nerve', 'scala-vestibuli'];

const GIZMO_AXES: { id: string; dir: Vec3; text: string }[] = [
  { id: 'lat', dir: [1, 0, 0], text: '외' },
  { id: 'med', dir: [-1, 0, 0], text: '내' },
  { id: 'ant', dir: [0, 1, 0], text: '전' },
  { id: 'post', dir: [0, -1, 0], text: '후' },
  { id: 'sup', dir: [0, 0, 1], text: '상' },
  { id: 'inf', dir: [0, 0, -1], text: '하' },
];

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

  constructor(canvas: HTMLCanvasElement, offsetMm: Vec3) {
    this.canvas = canvas;
    this.offset = [offsetMm[0], offsetMm[1], offsetMm[2]];
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(STAGE);
    this.draco.setDecoderPath(publicUrl('draco/'));
    this.loader.setDRACOLoader(this.draco);

    this.camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, 0.05, 4000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.85;
    this.controls.zoomSpeed = 0.85;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 500;

    this.world.name = 'specimen';
    this.world.position.set(this.offset[0], this.offset[1], this.offset[2]);
    this.world.scale.set(1, 1, 1);
    this.world.add(this.structures, this.measures);
    this.scene.add(this.world);

    const hemi = new THREE.HemisphereLight('#f7f5f0', '#e7e2d8', 1.15);
    const key = new THREE.DirectionalLight('#ffffff', 1.05);
    key.position.set(90, 10, 50);
    this.keyLight = key;
    this.scene.add(hemi, key);

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
    parent.append(this.calloutLayer, this.gizmo);
    this.frameDefault(true);

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', () => {
      this.down = null;
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(parent);
    this.resize();
  }

  /** Starts drawing. Call after the meshes are loaded so decode is not starved. */
  start(): void {
    if (!this.running) return;
    this.renderer.setAnimationLoop(() => this.tick());
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

  async loadStructure(id: string, url: string, color: string, layer: string, opacity: number, label: string): Promise<void> {
    const gltf = await this.loader.loadAsync(url);
    const root = gltf.scene;
    const materials: THREE.MeshStandardMaterial[] = [];
    const meshes: THREE.Mesh[] = [];
    const outlines: THREE.Mesh[] = [];
    const found: THREE.Mesh[] = [];
    root.traverse((obj) => {
      if (isMesh(obj)) found.push(obj);
    });
    for (const obj of found) {
      this.warnIfScaled(obj, id);
      const material = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.72,
        metalness: 0,
        side: id === 'tympanic-membrane' ? THREE.DoubleSide : THREE.FrontSide,
        clippingPlanes: this.clipping,
      });
      const previous = obj.material;
      obj.material = material;
      const old = Array.isArray(previous) ? previous : [previous];
      old.forEach((item) => item.dispose());
      materials.push(material);
      meshes.push(obj);
      obj.userData.structureId = id;
      obj.userData.kind = 'structure';
      this.pickables.push(obj);
      const outline = new THREE.Mesh(obj.geometry, this.outlineMaterial);
      outline.visible = false;
      outline.renderOrder = 29;
      outline.userData.kind = 'outline';
      obj.add(outline);
      outlines.push(outline);
    }
    root.userData.structureId = id;
    this.structures.add(root);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.isEmpty() ? 1 : box.getSize(new THREE.Vector3()).length();
    const record: StructureRecord = {
      id,
      layer,
      object: root,
      materials,
      meshes,
      outlines,
      opacity,
      envelope: isEnvelope(id),
      size,
      color,
      label,
    };
    this.records.set(id, record);
    this.applyLook(record);
  }

  setLabel(id: string, label: string): void {
    const record = this.records.get(id);
    if (record) record.label = label;
    this.syncCallouts();
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
    this.refreshLook();
    if (id && frame) this.frameStructure(id);
    else this.syncCallouts();
  }

  /** Quiz highlight. The target stays opaque and is drawn in front of bone. */
  highlight(id: string | null, dimOthers: boolean, frame = false, spanMm = SELECTION_SPAN_MM, fit = false): void {
    this.selected = id;
    this.dimOthers = dimOthers && id !== null;
    this.linked.clear();
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
    this.boneTransparent = true;
    this.labelsHidden = this.mode === 'quiz';
    this.setMarker(null, '');
    this.refreshLook();
    this.moveCamera(this.worldPoint(DEFAULT_CAMERA.position), this.worldPoint(DEFAULT_CAMERA.target), DEFAULT_CAMERA.up, DEFAULT_CAMERA.fov, immediate);
    this.setClipping(null);
  }

  frameStructure(id: string, spanMm = SELECTION_SPAN_MM, fit = false): void {
    const record = this.records.get(id);
    if (!record) return;
    record.object.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(record.object);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const direction = this.camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-4) direction.set(1, -0.05, 0.15);
    direction.normalize();
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1.2);
    const span = fit ? Math.min(spanMm, Math.max(16, radius * 7)) : spanMm;
    const fov = (this.camera.fov * Math.PI) / 180;
    const distance = span / (2 * Math.tan(fov / 2));
    const position = center.clone().add(direction.multiplyScalar(distance));
    this.moveCamera([position.x, position.y, position.z], [center.x, center.y, center.z], [this.camera.up.x, this.camera.up.y, this.camera.up.z], this.camera.fov, false);
  }

  applyPreset(preset: Pick<DissectionStep, 'camera' | 'clipping' | 'visible' | 'hidden' | 'ghosted' | 'highlight'>): void {
    this.presetVis = {
      hidden: new Set(preset.hidden ?? []),
      ghosted: new Set(preset.ghosted ?? []),
      visible: preset.visible ? new Set(preset.visible) : null,
    };
    this.isolateId = null;
    const highlight = preset.highlight ?? null;
    this.selected = highlight;
    this.dimOthers = false;
    this.linked.clear();
    this.refreshLook();
    const position = preset.camera.position;
    const target = preset.camera.target;
    const up = preset.camera.up ?? [0, 0, 1];
    this.moveCamera(this.worldPoint(position), this.worldPoint(target), up, preset.camera.fov ?? DEFAULT_FOV, false);
    this.setClipping(preset.clipping?.enabled ? preset.clipping : null);
  }

  setMarker(position: Vec3 | null, label: string): void {
    this.markerLabel = position ? label : '';
    if (!position) {
      if (this.marker) this.marker.visible = false;
      this.syncCallouts();
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
  }

  setCrosshair(point: Vec3 | null): void {
    this.crosshair.visible = point !== null;
    if (!point) return;
    this.crosshair.position.set(point[0], point[1], point[2]);
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
    if (!options.pose) return;
    this.placePlane(record, options.pose, options.flipY === true);
  }

  dispose(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.controls.dispose();
    this.draco.dispose();
    this.outlineMaterial.dispose();
    this.renderer.dispose();
    this.calloutLayer.remove();
    this.gizmo.remove();
  }

  private worldPoint(specimen: Vec3): Vec3 {
    return [specimen[0] + this.offset[0], specimen[1] + this.offset[1], specimen[2] + this.offset[2]];
  }

  private tick(): void {
    if (!this.running) return;
    this.stepTween(performance.now());
    this.keyLight.position.copy(this.camera.position);
    const distance = this.camera.position.distanceTo(this.controls.target);
    const worldHeight = 2 * Math.tan((this.camera.fov * Math.PI) / 360) * Math.max(distance, 0.001);
    const pxPerMm = this.canvas.clientHeight / worldHeight;
    this.outlineUniform.value = Math.min(1.4, Math.max(0.2, 2.6 / Math.max(pxPerMm, 0.5)));
    this.controls.update();
    this.updateScaleBar();
    this.projectCallouts();
    this.projectGizmo();
    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const parent = this.canvas.parentElement ?? this.canvas;
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    if (width < 2 || height < 2) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
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
    if (line) line.style.width = `${Math.max(1, Math.round(chosen.px))}px`;
    if (label) label.textContent = `${chosen.mm} mm`;
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
  }

  private shown(record: StructureRecord): boolean {
    if (this.userHidden.has(record.id)) return false;
    if (this.isolateId) return record.id === this.isolateId;
    if (!this.presetVis) return true;
    if (this.presetVis.hidden.has(record.id)) return false;
    if (this.presetVis.visible && !this.presetVis.visible.has(record.id) && !this.presetVis.ghosted.has(record.id)) return false;
    return true;
  }

  private applyLook(record: StructureRecord): void {
    const visible = this.shown(record);
    record.object.visible = visible;
    const onTop = record.id === this.selected && visible;
    const dimmed = this.dimOthers && this.selected !== null && record.id !== this.selected;
    const defaultGhost = !this.presetVis && record.id === 'sinus-dura';
    const opacity = displayOpacity({
      id: record.id,
      base: record.opacity,
      selectedId: this.selected,
      dimOthers: this.dimOthers,
      ghost: this.presetVis?.ghosted.has(record.id) === true || defaultGhost,
      boneTransparent: this.boneTransparent,
    });
    for (const material of record.materials) {
      material.color.set(dimmed ? DIM_GRAY : record.color);
      material.opacity = opacity;
      material.transparent = opacity < 0.98;
      material.depthWrite = !onTop && opacity >= 0.9;
      material.depthTest = !onTop;
      material.polygonOffset = opacity < 0.98;
      material.polygonOffsetFactor = 1;
      material.polygonOffsetUnits = 1;
    }
    for (const mesh of record.meshes) mesh.renderOrder = onTop ? 30 : 0;
    for (const outline of record.outlines) outline.visible = onTop;
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
  }

  private moveCamera(position: Vec3, target: Vec3, up: Vec3, fov: number, immediate: boolean): void {
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
      if (this.selected && this.records.get(this.selected)?.object.visible) wanted.add(this.selected);
      else if (!this.selected) {
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
      button.addEventListener('pointerup', (event) => {
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
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.leaderSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.leaderSvg.replaceChildren();
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
    if (this.selected) {
      const record = this.records.get(this.selected);
      if (record?.object.visible) {
        const box = new THREE.Box3().setFromObject(record.object);
        place(this.selected, box.getCenter(new THREE.Vector3()), record.label);
      }
    }
    if (this.marker?.visible && this.markerLabel) {
      place('marker', this.marker.getWorldPosition(new THREE.Vector3()), this.markerLabel);
    }
  }

  private projectGizmo(): void {
    const direction = new THREE.Vector3();
    this.camera.getWorldDirection(direction);
    this.gizmoCam.position.copy(direction.multiplyScalar(-4));
    this.gizmoCam.up.copy(this.camera.up);
    this.gizmoCam.lookAt(0, 0, 0);
    this.gizmoCam.updateMatrixWorld();
    const project = (x: number, y: number, z: number) => {
      const point = new THREE.Vector3(x, y, z).project(this.gizmoCam);
      return { x: (point.x * 0.5 + 0.5) * 84, y: (-point.y * 0.5 + 0.5) * 84 };
    };
    const origin = project(0, 0, 0);
    this.gizmoSvg.replaceChildren();
    for (const axis of GIZMO_AXES) {
      const tip = project(axis.dir[0] * 1.05, axis.dir[1] * 1.05, axis.dir[2] * 1.05);
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(origin.x));
      line.setAttribute('y1', String(origin.y));
      line.setAttribute('x2', String(tip.x));
      line.setAttribute('y2', String(tip.y));
      line.setAttribute('stroke', '#222');
      line.setAttribute('stroke-width', '1.25');
      this.gizmoSvg.append(line);
      const label = this.gizmo.querySelector<HTMLElement>(`[data-axis="${axis.id}"]`);
      if (!label) continue;
      const textPos = project(axis.dir[0] * 1.35, axis.dir[1] * 1.35, axis.dir[2] * 1.35);
      label.style.left = `${textPos.x}px`;
      label.style.top = `${textPos.y}px`;
    }
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.down = { x: event.clientX, y: event.clientY };
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.down) return;
    const moved = Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y);
    this.down = null;
    if (moved > 10) return;
    const hit = this.cast(event.clientX, event.clientY);
    if (this.mode === 'measure') {
      if (!hit || hit.kind !== 'structure') return;
      if (this.points.length >= 2) this.points = [];
      this.points.push(hit.pointMm);
      this.redrawMeasurement();
      this.onMeasureHandler?.(this.measurementPoints());
      return;
    }
    this.onPickHandler?.(hit);
  };

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
        gathered.push({
          structureId,
          distance: hit.distance,
          size: record?.size ?? 1e6,
          central: sample.central,
          envelope: record?.envelope,
          point: hit.point.clone(),
          kind: 'structure',
        });
      }
    }
    const chosen = choosePick(gathered);
    if (!chosen) return null;
    const same = gathered.filter((item) => item.structureId === chosen.structureId);
    const central = same.filter((item) => item.central).sort((a, b) => a.distance - b.distance)[0];
    const pointHit = central ?? same.sort((a, b) => a.distance - b.distance)[0];
    if (!pointHit) return null;
    const local = this.world.worldToLocal(pointHit.point.clone());
    return {
      structureId: chosen.structureId,
      pointMm: [local.x, local.y, local.z],
      kind: pointHit.kind,
    };
  }
}
