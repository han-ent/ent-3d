import type { CanalFile, GraphFile, ParamsFile, Vec3, VorBundle } from './types';

/**
 * One vestibular step. No rendering.
 *
 * Phase 2 (unilateral hypofunction, head impulse, phone gyro) only changes
 * `StepInput`: scale a canal, or pass a short angular-velocity pulse.
 * Phase 3 (canalithiasis / cupulolithiasis) adds `canalithDegPerSec`.
 * The same graph and the same step function stay in place.
 */

export type StepInput = {
  /** Head angular velocity, Reid frame, degrees per second. */
  omegaReidDeg: Vec3;
  dt: number;
  /** 1 = intact afferent, 0 = no resting rate and no modulation. Missing ids stay 1. */
  canalScale?: Readonly<Record<string, number>>;
  /** Extra cupula deflection in deg/s. Phase 1 leaves this empty. */
  canalithDegPerSec?: Readonly<Record<string, number>>;
};

export type EyeVec = { right: Vec3; left: Vec3 };

export type VorState = {
  time: number;
  cupula: Record<string, number>;
  deflection: Record<string, number>;
  firing: Record<string, number>;
  storage: Record<string, number>;
  signal: Record<string, number>;
  vestibularDrive: Record<string, number>;
  muscle: Record<string, number>;
  /** What the eye is doing this step, slow or fast. */
  eyeOmega: EyeVec;
  /** Vestibular slow phase, before a quick-phase reset. */
  slowOmega: EyeVec;
  eyePos: EyeVec;
  fastPhase: { right: boolean; left: boolean };
};

export type ModelNumbers = {
  baseline: number;
  afferentGain: number;
  tauCupula: number;
  tauStorage: number;
  vorGain: number;
  plantScale: number;
  fastThreshold: number;
  fastSpeed: number;
  fastStop: number;
};

const EYE_SIDES = ['right', 'left'] as const;

function zeros(ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = 0;
  return out;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function mag(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function addScaled(target: Vec3, axis: Vec3, scale: number): void {
  target[0] += axis[0] * scale;
  target[1] += axis[1] * scale;
  target[2] += axis[2] * scale;
}

export function modelNumbers(params: ParamsFile): ModelNumbers {
  return {
    baseline: params.baselineSpikesPerSec.value,
    afferentGain: params.afferentGainSpikesPerDegPerSec.value,
    tauCupula: params.cupulaTimeConstantSec.value,
    tauStorage: params.velocityStorageSec.value,
    vorGain: params.vorGain.value,
    plantScale: params.plantScale.value,
    fastThreshold: params.fastPhaseThresholdDeg.value,
    fastSpeed: params.fastPhaseSpeedDegPerSec.value,
    fastStop: params.fastPhaseStopDeg.value,
  };
}

export function canalIdsOf(canals: CanalFile): string[] {
  return canals.canals.map((canal) => canal.id);
}

/** Nonzero-weight edges only. Throws if those edges loop. */
export function driveOrder(graph: GraphFile): string[] {
  const nodes = graph.nodes.map((node) => node.id);
  const incoming = new Map<string, number>();
  const next = new Map<string, string[]>();
  for (const id of nodes) {
    incoming.set(id, 0);
    next.set(id, []);
  }
  for (const edge of graph.edges) {
    if (!(edge.weight > 0)) continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    next.get(edge.from)?.push(edge.to);
  }
  const queue = nodes.filter((id) => (incoming.get(id) ?? 0) === 0);
  const ordered: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    ordered.push(id);
    for (const to of next.get(id) ?? []) {
      const left = (incoming.get(to) ?? 1) - 1;
      incoming.set(to, left);
      if (left === 0) queue.push(to);
    }
  }
  if (ordered.length !== nodes.length) {
    const stuck = nodes.filter((id) => !ordered.includes(id));
    throw new Error(`VOR drive graph has a cycle at ${stuck.join(', ')}`);
  }
  return ordered;
}

export function createState(bundle: VorBundle): VorState {
  const numbers = modelNumbers(bundle.params);
  const ids = bundle.graph.nodes.map((node) => node.id);
  const firing = zeros(ids);
  for (const canal of bundle.canals.canals) firing[canal.id] = numbers.baseline;
  const eye = (): EyeVec => ({ right: [0, 0, 0], left: [0, 0, 0] });
  return {
    time: 0,
    cupula: zeros(canalIdsOf(bundle.canals)),
    deflection: zeros(canalIdsOf(bundle.canals)),
    firing,
    storage: zeros(canalIdsOf(bundle.canals)),
    signal: zeros(ids),
    vestibularDrive: zeros(ids),
    muscle: zeros(ids),
    eyeOmega: eye(),
    slowOmega: eye(),
    eyePos: eye(),
    fastPhase: { right: false, left: false },
  };
}

function scaleOf(input: StepInput, id: string): number {
  const value = input.canalScale?.[id];
  return value === undefined || !Number.isFinite(value) ? 1 : value;
}

/**
 * Cupula is a high-pass of head velocity: it matches a velocity step, then
 * returns toward rest with the cupula time constant. Velocity storage is
 * added so the central signal outlasts the cupula. A constant afferent loss
 * (the tonic term) is not passed through that high-pass.
 */
function canalCentral(
  state: VorState,
  numbers: ModelNumbers,
  proj: number,
  canalith: number,
  scale: number,
  dt: number,
  id: string,
): number {
  const tauC = Math.max(numbers.tauCupula, 1e-3);
  const tauV = Math.max(numbers.tauStorage, 1e-3);
  const blend = 1 - Math.exp(-dt / tauC);
  const tracked = state.cupula[id] ?? 0;
  const nextTracked = tracked + (proj - tracked) * blend;
  state.cupula[id] = nextTracked;
  const deflection = proj - nextTracked + canalith;
  state.deflection[id] = deflection;
  const gain = numbers.afferentGain;
  const firing = Math.max(0, scale * (numbers.baseline + gain * deflection));
  state.firing[id] = firing;
  const resting = scale * numbers.baseline;
  const dynamic = gain === 0 ? 0 : (firing - resting) / gain;
  const tonic = gain === 0 ? 0 : (resting - numbers.baseline) / gain;
  const stored = state.storage[id] ?? 0;
  const leak = Math.exp(-dt / tauV);
  const drive = 1 / tauC - 1 / tauV;
  const nextStored = stored * leak + drive * dynamic * tauV * (1 - leak);
  state.storage[id] = nextStored;
  return dynamic + nextStored + tonic;
}

function slowEye(graph: GraphFile, signal: Record<string, number>, numbers: ModelNumbers): EyeVec {
  const eye: EyeVec = { right: [0, 0, 0], left: [0, 0, 0] };
  const scale = numbers.plantScale * numbers.vorGain;
  for (const node of graph.nodes) {
    if (node.kind !== 'muscle' || !node.axisReid) continue;
    const side = node.side === 'left' ? 'left' : 'right';
    addScaled(eye[side], node.axisReid, (signal[node.id] ?? 0) * scale);
  }
  return eye;
}

function integrateEye(
  pos: Vec3,
  slow: Vec3,
  fast: boolean,
  dt: number,
  numbers: ModelNumbers,
): { pos: Vec3; omega: Vec3; fast: boolean } {
  let beating = fast;
  if (!beating && mag(pos) >= numbers.fastThreshold) beating = true;
  if (!beating) {
    const next: Vec3 = [pos[0] + slow[0] * dt, pos[1] + slow[1] * dt, pos[2] + slow[2] * dt];
    return { pos: next, omega: [slow[0], slow[1], slow[2]], fast: false };
  }
  const size = mag(pos) || 1;
  const omega: Vec3 = [
    (-pos[0] / size) * numbers.fastSpeed,
    (-pos[1] / size) * numbers.fastSpeed,
    (-pos[2] / size) * numbers.fastSpeed,
  ];
  const next: Vec3 = [pos[0] + omega[0] * dt, pos[1] + omega[1] * dt, pos[2] + omega[2] * dt];
  if (next[0] * pos[0] + next[1] * pos[1] + next[2] * pos[2] <= 0 || mag(next) <= numbers.fastStop) {
    return { pos: [0, 0, 0], omega, fast: false };
  }
  return { pos: next, omega, fast: true };
}

export function step(bundle: VorBundle, state: VorState, input: StepInput, order = driveOrder(bundle.graph)): void {
  const dt = Number.isFinite(input.dt) && input.dt > 0 ? input.dt : 0;
  const numbers = modelNumbers(bundle.params);
  const central: Record<string, number> = {};
  for (const canal of bundle.canals.canals) {
    const proj = dot(input.omegaReidDeg, canal.excitatoryNormal);
    const canalith = input.canalithDegPerSec?.[canal.id] ?? 0;
    central[canal.id] = canalCentral(state, numbers, proj, canalith, scaleOf(input, canal.id), dt, canal.id);
  }

  const signal: Record<string, number> = {};
  for (const node of bundle.graph.nodes) signal[node.id] = 0;
  for (const canal of bundle.canals.canals) signal[canal.id] = central[canal.id] ?? 0;

  const incoming = new Map<string, { from: string; sign: number; weight: number }[]>();
  for (const edge of bundle.graph.edges) {
    if (!(edge.weight > 0)) continue;
    const list = incoming.get(edge.to) ?? [];
    list.push(edge);
    incoming.set(edge.to, list);
  }
  for (const id of order) {
    const edges = incoming.get(id);
    if (!edges || edges.length === 0) continue;
    let sum = 0;
    for (const edge of edges) sum += edge.sign * edge.weight * (signal[edge.from] ?? 0);
    signal[id] = sum;
  }
  state.signal = signal;

  const drive: Record<string, number> = {};
  for (const node of bundle.graph.nodes) {
    drive[node.id] = node.kind === 'muscle' ? (signal[node.id] ?? 0) : 0;
  }
  state.vestibularDrive = drive;

  const slow = slowEye(bundle.graph, signal, numbers);
  state.slowOmega = slow;

  for (const side of EYE_SIDES) {
    const moved = integrateEye(state.eyePos[side], slow[side], state.fastPhase[side], dt, numbers);
    state.eyePos[side] = moved.pos;
    state.eyeOmega[side] = moved.omega;
    state.fastPhase[side] = moved.fast;
  }

  const muscle: Record<string, number> = { ...drive };
  for (const side of EYE_SIDES) {
    if (!state.fastPhase[side]) continue;
    const omega = state.eyeOmega[side];
    for (const node of bundle.graph.nodes) {
      if (node.kind !== 'muscle' || node.side !== side || !node.axisReid) continue;
      muscle[node.id] = dot(node.axisReid, omega);
    }
  }
  state.muscle = muscle;
  state.time += dt;
}
