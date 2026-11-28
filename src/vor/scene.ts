import * as THREE from 'three';
import { choosePixelRatio } from '../shared/viewer/budget';
import type { AnatomyLines } from '../shared/label-lang';
import { nodePosition, reidToScene } from './frame';
import { clampPolar, zoomRadius, type OrbitView } from './orbit';
import type { Vec3, VorBundle } from './types';
import type { VorState } from './engine';

const WARM = new THREE.Color('#e07a3d');
const COOL = new THREE.Color('#3d7eb5');
const ACCENT = new THREE.Color('#8c2f1b');
const UP = new THREE.Vector3(0, 1, 0);

const CANAL_COLOR: Record<string, string> = {
  horizontal: '#6e8cbf',
  anterior: '#c46b4a',
  posterior: '#6e9a72',
};

type Anchor = { id: string; position: THREE.Vector3 };
type Tube = {
  mesh: THREE.Mesh;
  pulse: THREE.Mesh | null;
  from: string;
  to: string;
  sign: number;
  weight: number;
  phase: number;
};
type Muscle = {
  id: string;
  mesh: THREE.Mesh;
  side: 'right' | 'left';
  rest: THREE.Vector3;
};

export type LabelCopy = { id: string; lines: AnatomyLines };

/**
 * Draws the one shared space. It only reads simulator state.
 * Geometry is procedural and schematic.
 */
export class VorScene {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private head = new THREE.Group();
  private anchors = new Map<string, Anchor>();
  private tubes: Tube[] = [];
  private muscles: Muscle[] = [];
  private eyes = new Map<'right' | 'left', THREE.Group>();
  private pickables: THREE.Object3D[] = [];
  private materials = new Map<string, THREE.MeshStandardMaterial>();
  private labels: HTMLElement;
  private labelNodes = new Map<string, HTMLDivElement>();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private bundle: VorBundle;
  private orbit: OrbitView = { azimuth: 0.28, polar: 1.18, radius: 290, target: [0, 10, -8] };
  private fly: { from: OrbitView; to: OrbitView; start: number } | null = null;
  private interacting = false;
  private shown: string[] = [];
  private obstacle: { left: number; top: number; right: number; bottom: number } | null = null;
  private scratch = new THREE.Vector3();
  private scratchB = new THREE.Vector3();
  private scratchC = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, labels: HTMLElement, bundle: VorBundle) {
    this.canvas = canvas;
    this.labels = labels;
    this.bundle = bundle;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0xc4c2bc, 1);
    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 2000);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    const key = new THREE.DirectionalLight(0xffffff, 1.05);
    key.position.set(-40, 120, -180);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xd7e4f2, 0.45);
    fill.position.set(80, 20, 40);
    this.scene.add(fill);
    this.scene.add(this.head);
    this.build();
    this.resize();
  }

  setInteracting(active: boolean): void {
    if (this.interacting === active) return;
    this.interacting = active;
    this.resize();
  }

  resize(): void {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    const compact = width < 900;
    this.renderer.setPixelRatio(choosePixelRatio(window.devicePixelRatio || 1, compact, this.interacting));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Replace the orbit, optionally sliding there. */
  flyTo(next: OrbitView, animate = true): void {
    if (!animate) {
      this.orbit = cloneView(next);
      this.fly = null;
      return;
    }
    this.fly = { from: cloneView(this.orbit), to: cloneView(next), start: performance.now() };
  }

  orbitBy(dx: number, dy: number): void {
    this.fly = null;
    this.orbit.azimuth -= dx;
    this.orbit.polar = clampPolar(this.orbit.polar - dy);
  }

  zoomBy(scale: number): void {
    this.fly = null;
    this.orbit.radius = zoomRadius(this.orbit.radius, scale);
  }

  resetHead(): void {
    this.head.quaternion.identity();
  }

  /** Canvas-local rectangle the labels should stay out of (the info sheet). */
  setLabelObstacle(rect: { left: number; top: number; right: number; bottom: number } | null): void {
    this.obstacle = rect;
  }

  /** Integrate head pose from the same angular velocity the canals see. */
  applyHead(omegaReid: Vec3, dt: number): void {
    if (dt <= 0) return;
    const axis = new THREE.Vector3(-omegaReid[1], omegaReid[2], -omegaReid[0]);
    const speed = axis.length();
    if (speed < 1e-6) return;
    axis.multiplyScalar(1 / speed);
    this.head.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axis, ((speed * dt) * Math.PI) / 180));
  }

  pick(clientX: number, clientY: number): string | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, false);
    for (const hit of hits) {
      const id = (hit.object.userData as { nodeId?: string }).nodeId;
      if (id) return id;
    }
    return null;
  }

  /** Move nuclei and retube the pathways. `anatomic` blends spread → clustered. */
  setLayout(anatomic: number): void {
    for (const [id, anchor] of this.anchors) {
      const next = nodePosition(this.bundle.layout, id, anatomic);
      anchor.position.set(next[0], next[1], next[2]);
    }
    const shrink = 1 - anatomic * 0.42;
    for (const node of this.bundle.graph.nodes) {
      if (node.kind !== 'nucleus' && node.kind !== 'tract') continue;
      const object = this.objectFor(node.id);
      if (object) object.scale.setScalar(node.kind === 'tract' ? shrink * 0.85 : shrink);
    }
    this.retube();
  }

  setLabels(copies: LabelCopy[], visible: readonly string[]): void {
    this.shown = [...visible];
    for (const copy of copies) {
      const el = this.labelNodes.get(copy.id);
      if (!el) continue;
      const main = el.querySelector('.vor-label-main');
      const sub = el.querySelector('.vor-label-sub');
      if (main) main.textContent = copy.lines.main;
      if (sub) {
        sub.textContent = copy.lines.sub ?? '';
        sub.toggleAttribute('hidden', !copy.lines.sub);
      }
    }
  }

  /**
   * Pose the eyes and muscles, then recolor from firing.
   * Call after setLayout for the frame.
   */
  applyState(state: VorState, highlighted: ReadonlySet<string> | null, baseline: number): void {
    for (const side of ['right', 'left'] as const) {
      const group = this.eyes.get(side);
      if (!group) continue;
      group.quaternion.copy(quatFromReid(state.eyePos[side]));
      const anchor = this.anchors.get(side === 'right' ? 'r-eye' : 'l-eye');
      if (anchor) group.position.copy(anchor.position);
    }
    for (const muscle of this.muscles) {
      const drive = state.muscle[muscle.id] ?? 0;
      const tone = Math.tanh(drive / 70);
      const eye = this.eyes.get(muscle.side);
      const eyeAnchor = this.anchors.get(muscle.side === 'right' ? 'r-eye' : 'l-eye');
      if (!eye || !eyeAnchor) continue;
      const insert = this.scratch.copy(muscle.rest).applyQuaternion(eye.quaternion).multiplyScalar(11.2).add(eyeAnchor.position);
      const reach = 27 * (tone > 0 ? 1 - 0.18 * tone : 1 - 0.05 * tone);
      const origin = this.scratchB.copy(muscle.rest).multiplyScalar(reach).add(eyeAnchor.position);
      const radius = 1.15 * (1 + 0.7 * tone);
      aimCylinder(muscle.mesh, origin, insert, Math.max(0.45, radius));
      this.paint(muscle.id, highlighted, tone, true);
    }
    for (const node of this.bundle.graph.nodes) {
      if (node.kind === 'muscle') continue;
      const firing = state.firing[node.id];
      const signal = state.signal[node.id] ?? 0;
      const hot = node.kind === 'canal' && firing !== undefined ? (firing - baseline) / Math.max(baseline, 1) : signal / 80;
      this.paint(node.id, highlighted, hot, false);
    }
    const travel = state.time;
    for (const tube of this.tubes) {
      const from = this.anchors.get(tube.from);
      const to = this.anchors.get(tube.to);
      if (!from || !to) continue;
      aimCylinder(tube.mesh, from.position, to.position, tube.weight > 0 ? 0.7 : 0.38);
      const selected = !highlighted || highlighted.has(tube.from) || highlighted.has(tube.to);
      const mat = tube.mesh.material as THREE.MeshStandardMaterial;
      mat.color.copy(tube.sign < 0 ? COOL : WARM);
      mat.opacity = selected ? 0.72 : highlighted ? 0.08 : 0.4;
      mat.emissive.copy(tube.sign < 0 ? COOL : WARM);
      mat.emissiveIntensity = selected ? 0.35 : 0;
      if (!tube.pulse) continue;
      const sourceFiring = state.firing[tube.from];
      const activity =
        sourceFiring !== undefined
          ? clamp((sourceFiring / Math.max(baseline * 2, 1)) , 0.08, 1)
          : clamp(Math.abs(state.signal[tube.from] ?? 0) / 90, 0.08, 1);
      const along = (travel * 0.42 + tube.phase) % 1;
      tube.pulse.position.copy(from.position).lerp(to.position, along);
      const scale = (1.15 + activity * 2.6) * (selected ? 1 : 0.25);
      tube.pulse.scale.setScalar(scale);
      const pulseMat = tube.pulse.material as THREE.MeshBasicMaterial;
      pulseMat.color.copy(tube.sign < 0 ? COOL : WARM);
      pulseMat.opacity = selected ? 0.35 + activity * 0.65 : 0.05;
    }
  }

  render(now = performance.now()): void {
    if (this.fly) {
      const t = Math.min(1, (now - this.fly.start) / 680);
      const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
      this.orbit = mixView(this.fly.from, this.fly.to, e);
      if (t >= 1) this.fly = null;
    }
    const polar = this.orbit.polar;
    const sp = Math.sin(polar);
    this.camera.position.set(
      this.orbit.target[0] + this.orbit.radius * sp * Math.sin(this.orbit.azimuth),
      this.orbit.target[1] + this.orbit.radius * Math.cos(polar),
      this.orbit.target[2] - this.orbit.radius * sp * Math.cos(this.orbit.azimuth),
    );
    this.camera.lookAt(this.orbit.target[0], this.orbit.target[1], this.orbit.target[2]);
    this.head.updateMatrixWorld();
    this.placeLabels();
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.dispose();
  }

  private build(): void {
    for (const node of this.bundle.graph.nodes) {
      const at = nodePosition(this.bundle.layout, node.id, 0);
      this.anchors.set(node.id, { id: node.id, position: new THREE.Vector3(at[0], at[1], at[2]) });
    }
    this.buildShell();
    this.buildCanals();
    this.buildNodes();
    this.buildEyes();
    this.buildMuscles();
    this.buildTubes();
    this.buildLabelDom();
    this.setLayout(0);
  }

  private buildShell(): void {
    const skin = new THREE.MeshStandardMaterial({
      color: '#e4c2ae',
      transparent: true,
      opacity: 0.14,
      roughness: 0.72,
      depthWrite: false,
    });
    const head = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 18), skin);
    head.scale.set(80, 98, 92);
    head.position.set(0, 8, -4);
    this.head.add(head);
    this.materials.set('head', skin);

    const nub = new THREE.MeshStandardMaterial({ color: '#d7b09a', roughness: 0.7 });
    for (const x of [86, -86]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(9, 12, 10), nub);
      ear.position.set(x, 4, 10);
      ear.scale.set(0.7, 1, 0.55);
      this.head.add(ear);
    }
    const nose = new THREE.Mesh(new THREE.SphereGeometry(7, 12, 10), nub);
    nose.position.set(0, 4, -96);
    nose.scale.set(1, 0.8, 0.7);
    this.head.add(nose);

    const stemMat = new THREE.MeshStandardMaterial({ color: '#d7a8a0', roughness: 0.62, transparent: true, opacity: 0.78 });
    const stem = new THREE.Mesh(new THREE.CapsuleGeometry(15, 52, 4, 10), stemMat);
    const stemAt = this.anchors.get('brainstem');
    if (stemAt) stem.position.copy(stemAt.position);
    stem.userData.nodeId = 'brainstem';
    this.head.add(stem);
    this.pickables.push(stem);
    this.materials.set('brainstem', stemMat);
  }

  private buildCanals(): void {
    for (const canal of this.bundle.canals.canals) {
      const geo = new THREE.TorusGeometry(9.2, 1.25, 6, 22, Math.PI * 1.55);
      const mat = new THREE.MeshStandardMaterial({
        color: CANAL_COLOR[canal.plane] ?? '#888888',
        roughness: 0.45,
        metalness: 0.05,
        emissive: '#000000',
      });
      const mesh = new THREE.Mesh(geo, mat);
      const anchor = this.anchors.get(canal.id);
      if (anchor) mesh.position.copy(anchor.position);
      const axis = new THREE.Vector3(...reidToScene(canal.excitatoryNormal)).normalize();
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
      mesh.userData.nodeId = canal.id;
      this.head.add(mesh);
      this.pickables.push(mesh);
      this.materials.set(canal.id, mat);
      const amp = new THREE.Mesh(new THREE.SphereGeometry(2.3, 10, 8), mat);
      amp.position.set(9.2, 0, 0);
      amp.userData.nodeId = canal.id;
      mesh.add(amp);
      this.pickables.push(amp);
    }
  }

  private buildNodes(): void {
    for (const node of this.bundle.graph.nodes) {
      if (node.kind !== 'nucleus' && node.kind !== 'tract' && node.kind !== 'nerve') continue;
      const radius = node.kind === 'nerve' ? 1.7 : node.kind === 'tract' ? 2.2 : 3.3;
      const color = node.kind === 'nerve' ? '#e0c078' : node.kind === 'tract' ? '#d9c7a2' : '#7d5d86';
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, emissive: '#000000' });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 10), mat);
      const anchor = this.anchors.get(node.id);
      if (anchor) mesh.position.copy(anchor.position);
      mesh.userData.nodeId = node.id;
      this.head.add(mesh);
      this.pickables.push(mesh);
      this.materials.set(node.id, mat);
    }
  }

  private buildEyes(): void {
    for (const side of ['right', 'left'] as const) {
      const id = side === 'right' ? 'r-eye' : 'l-eye';
      const group = new THREE.Group();
      const anchor = this.anchors.get(id);
      if (anchor) group.position.copy(anchor.position);
      const white = new THREE.MeshStandardMaterial({ color: '#f4f1ea', roughness: 0.35 });
      const globe = new THREE.Mesh(new THREE.SphereGeometry(12, 20, 16), white);
      globe.userData.nodeId = id;
      group.add(globe);
      this.pickables.push(globe);
      const iris = new THREE.Mesh(
        new THREE.SphereGeometry(5.6, 16, 12),
        new THREE.MeshStandardMaterial({ color: '#6d8494', roughness: 0.4 }),
      );
      iris.position.set(0, 0, -9.4);
      group.add(iris);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(2.5, 12, 10), new THREE.MeshBasicMaterial({ color: '#1a1a1a' }));
      pupil.position.set(0, 0, -10.6);
      group.add(pupil);
      this.head.add(group);
      this.eyes.set(side, group);
      this.materials.set(id, white);
    }
  }

  private buildMuscles(): void {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 8);
    for (const node of this.bundle.graph.nodes) {
      if (node.kind !== 'muscle') continue;
      const side = node.side === 'left' ? 'left' : 'right';
      const eyeId = side === 'left' ? 'l-eye' : 'r-eye';
      const eye = this.anchors.get(eyeId);
      const belly = this.anchors.get(node.id);
      if (!eye || !belly) continue;
      const rest = belly.position.clone().sub(eye.position);
      if (rest.lengthSq() < 1) rest.set(side === 'right' ? 1 : -1, 0, 0);
      else rest.normalize();
      const mat = new THREE.MeshStandardMaterial({ color: '#c4786a', roughness: 0.55, emissive: '#000000' });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.nodeId = node.id;
      this.head.add(mesh);
      this.pickables.push(mesh);
      this.materials.set(node.id, mat);
      this.muscles.push({ id: node.id, mesh, side, rest });
    }
  }

  private buildTubes(): void {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 6);
    this.bundle.graph.edges.forEach((edge, index) => {
      const mat = new THREE.MeshStandardMaterial({
        color: edge.sign < 0 ? '#3d7eb5' : '#e07a3d',
        transparent: true,
        opacity: 0.42,
        roughness: 0.4,
        depthWrite: false,
        emissive: edge.sign < 0 ? '#3d7eb5' : '#e07a3d',
        emissiveIntensity: 0.2,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.nodeId = edge.to;
      this.head.add(mesh);
      this.pickables.push(mesh);
      let pulse: THREE.Mesh | null = null;
      if (edge.weight > 0) {
        const pulseMat = new THREE.MeshBasicMaterial({
          color: edge.sign < 0 ? '#7eb6e0' : '#ffb07a',
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        });
        pulse = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), pulseMat);
        this.head.add(pulse);
      }
      this.tubes.push({
        mesh,
        pulse,
        from: edge.from,
        to: edge.to,
        sign: edge.sign,
        weight: edge.weight,
        phase: (index * 0.17) % 1,
      });
    });
  }

  private buildLabelDom(): void {
    for (const node of this.bundle.graph.nodes) {
      if (node.id === 'head') continue;
      const el = document.createElement('div');
      el.className = 'vor-label';
      el.dataset.nodeId = node.id;
      el.innerHTML = '<span class="vor-label-main"></span><span class="vor-label-sub"></span>';
      el.hidden = true;
      this.labels.append(el);
      this.labelNodes.set(node.id, el);
    }
  }

  private retube(): void {
    for (const node of this.bundle.graph.nodes) {
      if (node.kind === 'canal' || node.kind === 'muscle' || node.kind === 'eye') continue;
      const object = this.objectFor(node.id);
      const anchor = this.anchors.get(node.id);
      if (object && anchor && node.kind !== 'landmark') object.position.copy(anchor.position);
    }
    const stem = this.objectFor('brainstem');
    const stemAt = this.anchors.get('brainstem');
    if (stem && stemAt) stem.position.copy(stemAt.position);
  }

  private objectFor(id: string): THREE.Object3D | null {
    return this.pickables.find((mesh) => (mesh.userData as { nodeId?: string }).nodeId === id) ?? null;
  }

  private paint(id: string, highlighted: ReadonlySet<string> | null, hot: number, muscle: boolean): void {
    const mat = this.materials.get(id);
    if (!mat || id === 'head' || id === 'brainstem') return;
    const dim = Boolean(highlighted && !highlighted.has(id));
    mat.transparent = dim;
    mat.opacity = dim ? 0.15 : 1;
    mat.depthWrite = !dim;
    if (dim) {
      mat.emissive.set('#000000');
      mat.emissiveIntensity = 0;
      return;
    }
    const selected = Boolean(highlighted?.has(id));
    if (muscle) {
      mat.emissive.copy(hot >= 0 ? WARM : COOL);
      mat.emissiveIntensity = Math.min(0.9, Math.abs(hot)) + (selected ? 0.25 : 0);
      return;
    }
    if (hot > 0.08) {
      mat.emissive.copy(WARM);
      mat.emissiveIntensity = Math.min(0.85, hot);
    } else if (hot < -0.08) {
      mat.emissive.copy(COOL);
      mat.emissiveIntensity = Math.min(0.85, -hot);
    } else if (selected) {
      mat.emissive.copy(ACCENT);
      mat.emissiveIntensity = 0.45;
    } else {
      mat.emissive.set('#000000');
      mat.emissiveIntensity = 0;
    }
  }

  private placeLabels(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const cap = width < 800 ? 8 : 12;
    const allow = this.shown.slice(0, cap);
    for (const el of this.labelNodes.values()) el.hidden = true;
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    for (const id of allow) {
      const el = this.labelNodes.get(id);
      const anchor = this.anchors.get(id);
      if (!el || !anchor) continue;
      this.scratchC.copy(anchor.position).applyMatrix4(this.head.matrixWorld).project(this.camera);
      if (this.scratchC.z > 1 || this.scratchC.z < -1) {
        el.hidden = true;
        continue;
      }
      const x = (this.scratchC.x * 0.5 + 0.5) * width;
      const y = (-this.scratchC.y * 0.5 + 0.5) * height;
      if (x < -40 || y < -20 || x > width + 40 || y > height - 8) {
        el.hidden = true;
        continue;
      }
      let left = x;
      let top = y;
      const boxW = 150;
      const boxH = 40;
      const blocked = (px: number, py: number) => {
        const overlap = placed.some(
          (item) => Math.abs(item.x - px) < (item.w + boxW) / 2 && Math.abs(item.y - py) < (item.h + boxH) / 2,
        );
        const obstacle = this.obstacle;
        const hitsSheet =
          obstacle !== null &&
          px + boxW / 2 > obstacle.left + 2 &&
          px - boxW / 2 < obstacle.right - 2 &&
          py > obstacle.top + 2 &&
          py - boxH < obstacle.bottom;
        return overlap || hitsSheet;
      };
      for (let pass = 0; pass < 8 && blocked(left, top); pass += 1) {
        if (this.obstacle && top > this.obstacle.top) top = this.obstacle.top - 6;
        else top -= 42;
      }
      if (top < 72 || top > height - 8 || blocked(left, top)) {
        el.hidden = true;
        continue;
      }
      placed.push({ x: left, y: top, w: boxW, h: boxH });
      el.hidden = false;
      el.style.transform = `translate(${left}px, ${top}px)`;
    }
  }
}

const AIM_DIR = new THREE.Vector3();
const AIM_MID = new THREE.Vector3();

function aimCylinder(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, radius: number): void {
  AIM_DIR.subVectors(b, a);
  const length = Math.max(AIM_DIR.length(), 0.4);
  AIM_DIR.multiplyScalar(1 / length);
  AIM_MID.addVectors(a, b).multiplyScalar(0.5);
  mesh.position.copy(AIM_MID);
  if (AIM_DIR.dot(UP) < -0.999) mesh.quaternion.set(1, 0, 0, 0);
  else mesh.quaternion.setFromUnitVectors(UP, AIM_DIR);
  mesh.scale.set(radius, length, radius);
}

function quatFromReid(v: Vec3): THREE.Quaternion {
  const axis = new THREE.Vector3(-v[1], v[2], -v[0]);
  const deg = axis.length();
  if (deg < 1e-6) return new THREE.Quaternion();
  axis.multiplyScalar(1 / deg);
  return new THREE.Quaternion().setFromAxisAngle(axis, (deg * Math.PI) / 180);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cloneView(view: OrbitView): OrbitView {
  return { azimuth: view.azimuth, polar: view.polar, radius: view.radius, target: [...view.target] };
}

function mixView(from: OrbitView, to: OrbitView, t: number): OrbitView {
  return {
    azimuth: from.azimuth + (to.azimuth - from.azimuth) * t,
    polar: from.polar + (to.polar - from.polar) * t,
    radius: from.radius + (to.radius - from.radius) * t,
    target: [
      from.target[0] + (to.target[0] - from.target[0]) * t,
      from.target[1] + (to.target[1] - from.target[1]) * t,
      from.target[2] + (to.target[2] - from.target[2]) * t,
    ],
  };
}
