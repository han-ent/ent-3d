import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { SlicePose } from '../ct';
import { chooseScaleMm, worldClippingPlane } from '../measurement';
import type { Vec3, ViewPreset } from '../types';

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
  opacity: number;
};

type PlaneRecord = {
  mesh: THREE.Mesh;
  texture: THREE.Texture;
  material: THREE.MeshBasicMaterial;
};

const DEFAULT_FOV = 40;

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
  private records = new Map<string, StructureRecord>();
  private pickables: THREE.Object3D[] = [];
  private measureTargets: THREE.Object3D[] = [];
  private planes = new Map<string, PlaneRecord>();
  private clipping: THREE.Plane[] = [];
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private offset: Vec3;
  private mode: 'view' | 'measure' | 'quiz' = 'view';
  private selected: string | null = null;
  private dimOthers = false;
  private linked = new Set<string>();
  private points: Vec3[] = [];
  private scaleEl: HTMLElement | null = null;
  private down: { x: number; y: number } | null = null;
  private onPickHandler: ((hit: PickHit) => void) | null = null;
  private onMeasureHandler: ((points: Vec3[]) => void) | null = null;
  private resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, offsetMm: Vec3) {
    this.canvas = canvas;
    this.offset = [offsetMm[0], offsetMm[1], offsetMm[2]];
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color('#121a21');

    this.camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, 0.05, 4000);
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

    const hemi = new THREE.HemisphereLight('#e9f3f8', '#3d342c', 1.2);
    const key = new THREE.DirectionalLight('#ffffff', 1.45);
    key.position.set(40, 55, 28);
    const fill = new THREE.DirectionalLight('#8eb4cc', 0.5);
    fill.position.set(-28, 12, -20);
    this.scene.add(hemi, key, fill);

    this.camera.position.set(36, 24, 36);
    this.controls.target.set(this.offset[0], this.offset[1], this.offset[2]);

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', () => {
      this.down = null;
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  setScaleElement(element: HTMLElement | null): void {
    this.scaleEl = element;
  }

  setMode(mode: 'view' | 'measure' | 'quiz'): void {
    this.mode = mode;
  }

  onPick(handler: (hit: PickHit) => void): void {
    this.onPickHandler = handler;
  }

  onMeasure(handler: (points: Vec3[]) => void): void {
    this.onMeasureHandler = handler;
  }

  async loadStructure(id: string, url: string, color: string, layer: string, opacity: number): Promise<void> {
    const gltf = await this.loader.loadAsync(url);
    const root = gltf.scene;
    const materials: THREE.MeshStandardMaterial[] = [];
    root.traverse((obj) => {
      if (!isMesh(obj)) return;
      this.warnIfScaled(obj, id);
      const material = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.58,
        metalness: 0.04,
        side: THREE.DoubleSide,
        clippingPlanes: this.clipping,
      });
      const previous = obj.material;
      obj.material = material;
      const old = Array.isArray(previous) ? previous : [previous];
      old.forEach((item) => item.dispose());
      materials.push(material);
      obj.userData.structureId = id;
      obj.userData.kind = 'structure';
      this.pickables.push(obj);
      this.measureTargets.push(obj);
    });
    root.userData.structureId = id;
    this.structures.add(root);
    const record: StructureRecord = { id, layer, object: root, materials, opacity };
    this.records.set(id, record);
    this.applyLook(record);
  }

  setLayerVisible(layer: string, visible: boolean): void {
    for (const record of this.records.values()) {
      if (record.layer === layer) record.object.visible = visible;
    }
  }

  setLayerOpacity(layer: string, opacity: number): void {
    for (const record of this.records.values()) {
      if (record.layer !== layer) continue;
      record.opacity = opacity;
      this.applyLook(record);
    }
  }

  select(id: string | null): void {
    this.selected = id;
    this.dimOthers = false;
    this.linked.clear();
    this.refreshLook();
  }

  /** Highlight one structure. `dimOthers` is used by the name-the-structure quiz. */
  highlight(id: string | null, dimOthers: boolean): void {
    this.selected = id;
    this.dimOthers = dimOthers && id !== null;
    this.linked.clear();
    this.refreshLook();
  }

  /**
   * Emphasise functionally related structures while keeping the current selection.
   * Pass the related ids only; the selected structure stays the primary highlight.
   */
  link(ids: string[]): void {
    this.linked = new Set(ids.filter((id) => id !== this.selected));
    this.refreshLook();
  }

  frameAll(): void {
    this.structures.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(this.structures);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5;
    this.camera.up.set(0, 1, 0);
    this.camera.fov = DEFAULT_FOV;
    const distance = (radius / Math.tan((DEFAULT_FOV * Math.PI) / 360)) * 1.45;
    this.camera.position.set(center.x + distance * 0.55, center.y + distance * 0.38, center.z + distance * 0.72);
    this.controls.target.copy(center);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.setClipping(null);
  }

  applyPreset(preset: ViewPreset): void {
    const position = preset.camera.position;
    const target = preset.camera.target;
    const up = preset.camera.up ?? [0, 1, 0];
    this.camera.up.set(up[0], up[1], up[2]);
    this.camera.position.set(position[0] + this.offset[0], position[1] + this.offset[1], position[2] + this.offset[2]);
    this.controls.target.set(target[0] + this.offset[0], target[1] + this.offset[1], target[2] + this.offset[2]);
    this.camera.fov = preset.camera.fov ?? DEFAULT_FOV;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.setClipping(preset.clipping?.enabled ? preset.clipping : null);
  }

  clearMeasurement(): void {
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
  }): void {
    let record = this.planes.get(options.id);
    if (!record) {
      const texture = new THREE.Texture();
      texture.colorSpace = THREE.SRGBColorSpace;
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
      this.measureTargets.push(mesh);
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
    this.placePlane(record, options.pose);
  }

  dispose(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.controls.dispose();
    this.renderer.dispose();
  }

  private running = true;

  private tick(): void {
    if (!this.running) return;
    this.controls.update();
    this.updateScaleBar();
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
  }

  private applyLook(record: StructureRecord): void {
    const active = record.id === this.selected;
    const linked = !this.dimOthers && this.linked.has(record.id);
    const opacity = this.dimOthers && !active ? Math.min(record.opacity, 0.14) : record.opacity;
    for (const material of record.materials) {
      material.opacity = opacity;
      material.transparent = opacity < 0.98;
      material.depthWrite = opacity >= 0.85;
      material.emissive.set(active ? '#14685a' : linked ? '#a15c12' : '#000000');
      material.emissiveIntensity = active ? 0.65 : linked ? 0.9 : 0;
    }
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

  private placePlane(record: PlaneRecord, pose: SlicePose): void {
    const u = new THREE.Vector3(pose.u[0], pose.u[1], pose.u[2]).normalize();
    const v = new THREE.Vector3(pose.v[0], pose.v[1], pose.v[2]).normalize();
    const normal = new THREE.Vector3(pose.normal[0], pose.normal[1], pose.normal[2]).normalize();
    const mirror = new THREE.Vector3().crossVectors(u, v).dot(normal) < 0;
    if (mirror) u.negate();
    const basis = new THREE.Matrix4().makeBasis(u, v, normal);
    record.mesh.quaternion.setFromRotationMatrix(basis);
    record.mesh.position.set(pose.position[0], pose.position[1], pose.position[2]);
    record.mesh.scale.set(1, 1, 1);
    record.mesh.geometry.dispose();
    record.mesh.geometry = new THREE.PlaneGeometry(pose.width, pose.height);
    record.texture.wrapS = THREE.RepeatWrapping;
    record.texture.center.set(0.5, 0.5);
    record.texture.repeat.x = mirror ? -1 : 1;
    record.texture.offset.set(0, 0);
    record.texture.needsUpdate = true;
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
        new THREE.SphereGeometry(0.45, 18, 12),
        new THREE.MeshBasicMaterial({ color: '#f4d35e' }),
      );
      mesh.position.set(point[0], point[1], point[2]);
      this.measures.add(mesh);
    }
    if (this.points.length === 2) {
      const start = new THREE.Vector3(...this.points[0]);
      const end = new THREE.Vector3(...this.points[1]);
      const direction = end.clone().sub(start);
      const length = direction.length();
      if (length > 0.001) {
        const mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.12, 0.12, length, 8),
          new THREE.MeshBasicMaterial({ color: '#f4d35e' }),
        );
        mesh.position.copy(start).add(end).multiplyScalar(0.5);
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
        this.measures.add(mesh);
      }
    }
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.down = { x: event.clientX, y: event.clientY };
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.down) return;
    const moved = Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y);
    this.down = null;
    if (moved > 8) return;
    const targets = this.mode === 'measure' ? this.measureTargets : this.pickables;
    const hit = this.cast(event, targets);
    if (!hit) return;
    if (this.mode === 'measure') {
      if (this.points.length >= 2) this.points = [];
      this.points.push(hit.pointMm);
      this.redrawMeasurement();
      this.onMeasureHandler?.(this.measurementPoints());
      return;
    }
    if (hit.kind === 'structure') this.onPickHandler?.(hit);
  };

  private cast(event: PointerEvent, targets: THREE.Object3D[]): PickHit | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(targets, false);
    const hit = hits.find((item) => isShown(item.object));
    if (!hit) return null;
    const local = this.world.worldToLocal(hit.point.clone());
    const kind = hit.object.userData.kind === 'ct' ? 'ct' : 'structure';
    return {
      structureId: String(hit.object.userData.structureId ?? ''),
      pointMm: [local.x, local.y, local.z],
      kind,
    };
  }
}
