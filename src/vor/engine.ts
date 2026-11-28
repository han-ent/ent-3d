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
  /** Accumulated gaze slip (head + eye), used for a catch-up saccade. */
  gazeError: EyeVec;
  fastPhase: { right: boolean; left: boolean };
  /** Rapid compensatory saccade when an impulse outruns a weak VOR. */
  catchUp: { right: boolean; left: boolean };
  /** False after one catch-up, until head speed falls. Stops a held turn from repeating it. */
  catchArmed: { right: boolean; left: boolean };
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
  inhibitorySaturation: number;
  staticImbalanceGain: number;
  verticalRestingScale: number;
  torsionalVorGain: number;
  torsionalStorage: number;
  catchUpThreshold: number;
  catchUpMinHead: number;
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
    inhibitorySaturation: params.inhibitorySaturationDegPerSec.value,
    staticImbalanceGain: params.staticImbalanceGain.value,
    verticalRestingScale: params.verticalRestingScale.value,
    torsionalVorGain: params.torsionalVorGain.value,
    torsionalStorage: params.torsionalStorageSec.value,
    catchUpThreshold: params.catchUpThresholdDeg.value,
    catchUpMinHead: params.catchUpMinHeadDegPerSec.value,
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
    gazeError: eye(),
    fastPhase: { right: false, left: false },
    catchUp: { right: false, left: false },
    catchArmed: { right: true, left: true },
  };
}

function scaleOf(input: StepInput, id: string): number {
  const value = input.canalScale?.[id];
  return value === undefined || !Number.isFinite(value) ? 1 : value;
}

const PAIRS: readonly (readonly [string, string])[] = [
  ['rhc', 'lhc'],
  ['rac', 'lpc'],
  ['lac', 'rpc'],
];

/**
 * Cupula is a high-pass of head velocity. Inhibition of the afferent is
 * clipped at a modest canal velocity (Ewald II); excitation is not.
 * Velocity storage prolongs only the dynamic signal. A resting-rate loss
 * is returned separately so it can be scaled before it reaches the eye.
 */
function canalSignals(
  state: VorState,
  numbers: ModelNumbers,
  proj: number,
  canalith: number,
  scale: number,
  dt: number,
  id: string,
  tauStorage: number,
): { dynamic: number; tonic: number } {
  const tauC = Math.max(numbers.tauCupula, 1e-3);
  const tauV = Math.max(tauStorage, tauC);
  const blend = 1 - Math.exp(-dt / tauC);
  const tracked = state.cupula[id] ?? 0;
  const nextTracked = tracked + (proj - tracked) * blend;
  state.cupula[id] = nextTracked;
  const deflection = proj - nextTracked + canalith;
  state.deflection[id] = deflection;
  const gain = numbers.afferentGain === 0 ? 1 : numbers.afferentGain;
  const sat = Math.max(numbers.inhibitorySaturation, 1);
  const peripheral = deflection >= 0 ? deflection : Math.max(deflection, -sat);
  const firing = Math.max(0, scale * (numbers.baseline + gain * peripheral));
  state.firing[id] = firing;
  const alive = scale > 0.01;
  const driven = alive ? peripheral : 0;
  const stored = state.storage[id] ?? 0;
  const leak = Math.exp(-dt / tauV);
  const charge = Math.max(0, 1 / tauC - 1 / tauV);
  const nextStored = stored * leak + charge * driven * tauV * (1 - leak);
  state.storage[id] = nextStored;
  const tonic = ((alive ? scale : 0) - 1) * (numbers.baseline / gain);
  return { dynamic: driven + nextStored, tonic };
}

/** Vertical-canal resting loss is scaled again so spontaneous nystagmus stays horizontal-dominant. */
function restingWeight(id: string, gain: number, verticalScale: number): number {
  const vertical = id === 'rac' || id === 'lac' || id === 'rpc' || id === 'lpc';
  return vertical ? gain * verticalScale : gain;
}

/** Excitatory afferent carries the velocity; a saturated inhibitory partner does not pull it down. */
function pairEstimate(first: number, second: number, firstAlive: boolean, secondAlive: boolean): number {
  if (!firstAlive && !secondAlive) return 0;
  if (firstAlive && !secondAlive) return first;
  if (!firstAlive && secondAlive) return -second;
  const flipped = -second;
  return Math.abs(first) >= Math.abs(flipped) ? first : flipped;
}

function slowEye(graph: GraphFile, signal: Record<string, number>, numbers: ModelNumbers): EyeVec {
  const eye: EyeVec = { right: [0, 0, 0], left: [0, 0, 0] };
  const scale = numbers.plantScale * numbers.vorGain;
  const torsion = Math.min(1, Math.max(0, numbers.torsionalVorGain));
  for (const node of graph.nodes) {
    if (node.kind !== 'muscle' || !node.axisReid) continue;
    const side = node.side === 'left' ? 'left' : 'right';
    addScaled(eye[side], node.axisReid, (signal[node.id] ?? 0) * scale);
  }
  eye.right[0] *= torsion;
  eye.left[0] *= torsion;
  return eye;
}

function add(a: Vec3, b: Vec3, scale = 1): Vec3 {
  return [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
}

function compensatoryGain(head: Vec3, slow: Vec3): number {
  const speed = mag(head);
  if (speed < 30) return 1;
  return -dot(slow, head) / (speed * speed);
}

/**
 * Centering quick phases reset a large orbital position.
 * A catch-up saccade is the other way: during a fast impulse the eye
 * jumps further in the compensatory direction to pay back gaze slip.
 */
function moveEye(
  pos: Vec3,
  gaze: Vec3,
  slow: Vec3,
  head: Vec3,
  fast: boolean,
  catching: boolean,
  armed: boolean,
  dt: number,
  numbers: ModelNumbers,
): { pos: Vec3; gaze: Vec3; omega: Vec3; fast: boolean; catchUp: boolean; armed: boolean } {
  const headSpeed = mag(head);
  let ready = armed;
  if (headSpeed < 40) ready = true;
  const slipped = add(gaze, add(head, slow), dt);
  const failed = compensatoryGain(head, slow) < 0.65;
  let catchUp = catching;
  if (!catchUp && ready && failed && headSpeed >= numbers.catchUpMinHead && mag(pos) < 12 && mag(slipped) >= numbers.catchUpThreshold) {
    catchUp = true;
    ready = false;
  }
  if (catchUp) {
    const size = mag(slipped) || 1;
    const omega: Vec3 = [
      (-slipped[0] / size) * numbers.fastSpeed,
      (-slipped[1] / size) * numbers.fastSpeed,
      (-slipped[2] / size) * numbers.fastSpeed,
    ];
    const next = add(pos, omega, dt);
    const nextGaze = add(gaze, add(head, omega), dt);
    const done = dot(nextGaze, slipped) <= 0 || mag(nextGaze) <= numbers.catchUpThreshold * 0.35 || mag(next) > 35;
    if (done) {
      return { pos: next, gaze: [0, 0, 0], omega, fast: false, catchUp: false, armed: false };
    }
    return { pos: next, gaze: nextGaze, omega, fast: false, catchUp: true, armed: false };
  }
  let beating = fast;
  if (!beating && mag(pos) >= numbers.fastThreshold) beating = true;
  if (!beating) {
    return { pos: add(pos, slow, dt), gaze: slipped, omega: [slow[0], slow[1], slow[2]], fast: false, catchUp: false, armed: ready };
  }
  const size = mag(pos) || 1;
  const omega: Vec3 = [
    (-pos[0] / size) * numbers.fastSpeed,
    (-pos[1] / size) * numbers.fastSpeed,
    (-pos[2] / size) * numbers.fastSpeed,
  ];
  const next = add(pos, omega, dt);
  if (dot(next, pos) <= 0 || mag(next) <= numbers.fastStop) {
    return { pos: [0, 0, 0], gaze: add(gaze, add(head, omega), dt), omega, fast: false, catchUp: false, armed: ready };
  }
  return { pos: next, gaze: add(gaze, add(head, omega), dt), omega, fast: true, catchUp: false, armed: ready };
}

export function step(bundle: VorBundle, state: VorState, input: StepInput, order = driveOrder(bundle.graph)): void {
  const dt = Number.isFinite(input.dt) && input.dt > 0 ? input.dt : 0;
  const numbers = modelNumbers(bundle.params);
  const dynamic: Record<string, number> = {};
  const tonic: Record<string, number> = {};
  const alive: Record<string, boolean> = {};
  for (const canal of bundle.canals.canals) {
    const proj = dot(input.omegaReidDeg, canal.excitatoryNormal);
    const canalith = input.canalithDegPerSec?.[canal.id] ?? 0;
    const scale = scaleOf(input, canal.id);
    const vertical = canal.plane !== 'horizontal';
    const signals = canalSignals(
      state,
      numbers,
      proj,
      canalith,
      scale,
      dt,
      canal.id,
      vertical ? numbers.torsionalStorage : numbers.tauStorage,
    );
    dynamic[canal.id] = signals.dynamic;
    tonic[canal.id] = signals.tonic;
    alive[canal.id] = scale > 0.01;
  }

  const signal: Record<string, number> = {};
  for (const node of bundle.graph.nodes) signal[node.id] = 0;
  const k = numbers.staticImbalanceGain;
  for (const [first, second] of PAIRS) {
    const estimate = pairEstimate(dynamic[first] ?? 0, dynamic[second] ?? 0, alive[first] === true, alive[second] === true);
    const verticalScale = numbers.verticalRestingScale;
    signal[first] = estimate + restingWeight(first, k, verticalScale) * (tonic[first] ?? 0);
    signal[second] = -estimate + restingWeight(second, k, verticalScale) * (tonic[second] ?? 0);
  }

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
    const moved = moveEye(
      state.eyePos[side],
      state.gazeError[side],
      slow[side],
      input.omegaReidDeg,
      state.fastPhase[side],
      state.catchUp[side],
      state.catchArmed[side],
      dt,
      numbers,
    );
    state.eyePos[side] = moved.pos;
    state.gazeError[side] = moved.gaze;
    state.eyeOmega[side] = moved.omega;
    state.fastPhase[side] = moved.fast;
    state.catchUp[side] = moved.catchUp;
    state.catchArmed[side] = moved.armed;
  }

  const muscle: Record<string, number> = { ...drive };
  for (const side of EYE_SIDES) {
    if (!state.fastPhase[side] && !state.catchUp[side]) continue;
    const omega = state.eyeOmega[side];
    for (const node of bundle.graph.nodes) {
      if (node.kind !== 'muscle' || node.side !== side || !node.axisReid) continue;
      muscle[node.id] = dot(node.axisReid, omega);
    }
  }
  state.muscle = muscle;
  state.time += dt;
}
