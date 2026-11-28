import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createState, driveOrder, modelNumbers, step, type StepInput, type VorState } from '../src/vor/engine';
import { connectedIds, excitatoryCanals, excitatoryChain } from '../src/vor/highlight';
import type { CanalFile, GraphFile, LayoutFile, ParamsFile, Vec3, VorBundle } from '../src/vor/types';

const root = resolve(import.meta.dirname, '..');

function load<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(root, 'public/vor', name), 'utf8')) as T;
}

const bundle: VorBundle = {
  canals: load<CanalFile>('canals.json'),
  graph: load<GraphFile>('graph.json'),
  params: load<ParamsFile>('params.json'),
  layout: load<LayoutFile>('layout.json'),
};

const numbers = modelNumbers(bundle.params);
const order = driveOrder(bundle.graph);
const eyes = new Set(['r-eye', 'l-eye']);
const canalIds = new Set(bundle.canals.canals.map((canal) => canal.id));

function normal(id: string): Vec3 {
  const canal = bundle.canals.canals.find((item) => item.id === id);
  if (!canal) throw new Error(id);
  return canal.excitatoryNormal;
}

function unit(v: Vec3): Vec3 {
  const scale = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / scale, v[1] / scale, v[2] / scale];
}

function scale(v: Vec3, gain: number): Vec3 {
  return [v[0] * gain, v[1] * gain, v[2] * gain];
}

function run(omega: Vec3, frames: number, extra: Partial<StepInput> = {}): VorState {
  const state = createState(bundle);
  const input: StepInput = { omegaReidDeg: omega, dt: 1 / 60, ...extra };
  for (let frame = 0; frame < frames; frame += 1) step(bundle, state, input, order);
  return state;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

describe('VOR data files', () => {
  it('keeps every anatomical name in English and Korean, and leaves values unverified', () => {
    for (const node of bundle.graph.nodes) {
      expect(node.nameEn.trim().length, node.id).toBeGreaterThan(0);
      expect(node.nameKo.trim().length, node.id).toBeGreaterThan(0);
      expect(node.reviewStatus).toBe('unverified');
      expect(node.source.length).toBeGreaterThan(0);
    }
    for (const edge of bundle.graph.edges) {
      expect(edge.reviewStatus).toBe('unverified');
      expect(edge.source.length).toBeGreaterThan(0);
      expect(edge.sign === 1 || edge.sign === -1).toBe(true);
    }
    for (const canal of bundle.canals.canals) {
      expect(canal.reviewStatus).toBe('unverified');
      expect(canal.source).toContain('Della Santina');
      expect(canal.source).toContain('2005');
      const length = Math.hypot(...canal.excitatoryNormal);
      expect(length).toBeGreaterThan(0.99);
      expect(length).toBeLessThan(1.01);
    }
    for (const cited of Object.values(bundle.params)) {
      if (typeof cited === 'string') continue;
      expect(cited.reviewStatus).toBe('unverified');
      expect(cited.source.length).toBeGreaterThan(0);
    }
    expect(bundle.layout.reviewStatus).toBe('unverified');
    for (const node of bundle.graph.nodes) {
      expect(bundle.layout.fixed[node.id] ?? bundle.layout.spread[node.id], node.id).toBeTruthy();
    }
  });

  it('matches Della Santina 2005 worked examples for the left canals', () => {
    const lh = normal('lhc');
    const la = normal('lac');
    const lp = normal('lpc');
    const yaw = [dot(lh, [0, 0, 100]), dot(la, [0, 0, 100]), dot(lp, [0, 0, 100])];
    expect(yaw[0]).toBeCloseTo(94.6, 0);
    expect(yaw[1]).toBeCloseTo(-17.7, 0);
    expect(yaw[2]).toBeCloseTo(-27.0, 0);
    const pitch = [dot(lh, [0, 100, 0]), dot(la, [0, 100, 0]), dot(lp, [0, 100, 0])];
    expect(pitch[0]).toBeCloseTo(-3.8, 0);
    expect(pitch[1]).toBeCloseTo(78.8, 0);
    expect(pitch[2]).toBeCloseTo(-66.7, 0);
  });
});

describe('VOR physiology', () => {
  it('drives a rightward yaw into the right horizontal canal and a leftward slow phase', () => {
    const state = run([0, 0, -60], 3);
    expect(state.firing.rhc).toBeGreaterThan(numbers.baseline);
    expect(state.firing.lhc).toBeLessThan(numbers.baseline);
    for (const side of ['right', 'left'] as const) {
      const omega = state.slowOmega[side];
      expect(omega[2]).toBeGreaterThan(0);
      expect(Math.abs(omega[2])).toBeGreaterThan(Math.abs(omega[0]));
      expect(Math.abs(omega[2])).toBeGreaterThan(Math.abs(omega[1]));
      expect(omega[2]).toBeGreaterThan(20);
      expect(omega[2]).toBeLessThan(90);
    }
    expect(state.vestibularDrive['r-mr']).toBeGreaterThan(0);
    expect(state.vestibularDrive['l-lr']).toBeGreaterThan(0);
    expect(state.vestibularDrive['r-lr']).toBeLessThan(0);
    expect(state.vestibularDrive['l-mr']).toBeLessThan(0);
    expect(state.fastPhase.right).toBe(false);
  });

  it('excites both anterior canals on nose-down pitch and elevates the eyes', () => {
    const state = run([0, 80, 0], 3);
    expect(state.firing.rac).toBeGreaterThan(numbers.baseline);
    expect(state.firing.lac).toBeGreaterThan(numbers.baseline);
    expect(state.firing.rpc).toBeLessThan(numbers.baseline);
    expect(state.firing.lpc).toBeLessThan(numbers.baseline);
    expect(state.slowOmega.right[1]).toBeLessThan(0);
    expect(state.slowOmega.left[1]).toBeLessThan(0);
    expect(state.vestibularDrive['r-sr']).toBeGreaterThan(0);
    expect(state.vestibularDrive['l-sr']).toBeGreaterThan(0);
    expect(state.vestibularDrive['r-io']).toBeGreaterThan(0);
    expect(state.vestibularDrive['l-io']).toBeGreaterThan(0);
  });

  it('maps LARP, RALP, and a posterior-canal rotation onto the agonist pairs', () => {
    const larp = run(scale(unit(normal('lac')), 80), 3);
    expect(larp.firing.lac).toBeGreaterThan(numbers.baseline);
    expect(larp.firing.rpc).toBeLessThan(numbers.baseline);
    expect(larp.vestibularDrive['l-sr']).toBeGreaterThan(0);
    expect(larp.vestibularDrive['r-io']).toBeGreaterThan(0);
    expect(larp.vestibularDrive['l-sr']).toBeGreaterThan(larp.vestibularDrive['r-sr']);

    const ralp = run(scale(unit(normal('rac')), 80), 3);
    expect(ralp.firing.rac).toBeGreaterThan(numbers.baseline);
    expect(ralp.firing.lpc).toBeLessThan(numbers.baseline);
    expect(ralp.vestibularDrive['r-sr']).toBeGreaterThan(0);
    expect(ralp.vestibularDrive['l-io']).toBeGreaterThan(0);
    expect(ralp.vestibularDrive['r-sr']).toBeGreaterThan(ralp.vestibularDrive['l-sr']);

    const posterior = run(scale(unit(normal('rpc')), 80), 3);
    expect(posterior.firing.rpc).toBeGreaterThan(numbers.baseline);
    expect(posterior.vestibularDrive['r-so']).toBeGreaterThan(0);
    expect(posterior.vestibularDrive['l-ir']).toBeGreaterThan(0);
    expect(posterior.vestibularDrive['r-so']).toBeGreaterThan(Math.abs(posterior.vestibularDrive['r-sr']));
  });

  it('never lets firing go negative, and shows Ewald asymmetry once the inhibited canal hits zero', () => {
    const axes: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      unit(normal('rac')),
      unit(normal('lac')),
      unit(normal('rpc')),
    ];
    for (const axis of axes) {
      for (const speed of [-400, -200, -40, 0, 40, 200, 400]) {
        const state = run(scale(axis, speed), 2);
        for (const canal of bundle.canals.canals) {
          expect(state.firing[canal.id], canal.id).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(state.firing[canal.id])).toBe(true);
        }
      }
    }
    const slow = run([0, 0, -30], 2);
    const fast = run([0, 0, -320], 2);
    const slowGap = Math.abs(slow.firing.rhc - numbers.baseline - (numbers.baseline - slow.firing.lhc));
    expect(slowGap).toBeLessThan(1);
    expect(fast.firing.lhc).toBe(0);
    expect(fast.firing.rhc - numbers.baseline).toBeGreaterThan(numbers.baseline - fast.firing.lhc);
  });

  it('resets the eye after the slow phase passes the position threshold', () => {
    const state = createState(bundle);
    let peak = 0;
    let sawFast = false;
    let sawReset = false;
    for (let frame = 0; frame < 240; frame += 1) {
      step(bundle, state, { omegaReidDeg: [0, 0, -70], dt: 1 / 60 }, order);
      peak = Math.max(peak, Math.abs(state.eyePos.right[2]));
      if (state.fastPhase.right) sawFast = true;
      if (sawFast && Math.abs(state.eyePos.right[2]) < 2) sawReset = true;
      expect(Number.isFinite(state.eyePos.right[2])).toBe(true);
      expect(Math.abs(state.firing.rhc)).toBeLessThan(500);
    }
    expect(peak).toBeGreaterThan(numbers.fastThreshold - 2);
    expect(sawReset).toBe(true);
    expect(state.slowOmega.right[2]).toBeGreaterThan(0);
  });

  it('makes a right afferent loss look like a left-beating resting nystagmus', () => {
    const state = run([0, 0, 0], 30, { canalScale: { rhc: 0, rac: 0, rpc: 0 } });
    expect(state.firing.rhc).toBe(0);
    expect(state.firing.rac).toBe(0);
    expect(state.firing.rpc).toBe(0);
    expect(state.firing.lhc).toBeCloseTo(numbers.baseline, 5);
    expect(state.slowOmega.right[2]).toBeLessThan(0);
    expect(state.slowOmega.left[2]).toBeLessThan(0);
  });

  it('keeps normal horizontal gain near 1 through high velocity, and drops only the lesion-side impulse', () => {
    const loss = { canalScale: { rhc: 0, rac: 0, rpc: 0 } };
    const ratio = (omega: Vec3, frames: number, extra: Partial<StepInput> = {}) => {
      const state = run(omega, frames, extra);
      const head = Math.hypot(omega[0], omega[1], omega[2]);
      const eye = state.slowOmega.right;
      return -((eye[0] * omega[0] + eye[1] * omega[1] + eye[2] * omega[2]) / (head * head));
    };
    expect(ratio([0, 0, -60], 4)).toBeGreaterThan(0.9);
    expect(ratio([0, 0, -60], 4)).toBeLessThan(1.08);
    expect(ratio([0, 0, -250], 4)).toBeGreaterThan(0.9);
    expect(ratio([0, 0, -300], 4)).toBeLessThan(1.08);
    const lesion = ratio([0, 0, -200], 6, loss);
    const healthy = ratio([0, 0, 200], 6, loss);
    expect(lesion).toBeGreaterThan(0.2);
    expect(lesion).toBeLessThan(0.4);
    expect(healthy).toBeGreaterThanOrEqual(0.8);
    expect(healthy).toBeGreaterThan(lesion * 2);

    const state = createState(bundle);
    let sawCatch = false;
    let catchSign = 0;
    for (let frame = 0; frame < 30; frame += 1) {
      step(bundle, state, { omegaReidDeg: [0, 0, -200], dt: 1 / 60, ...loss }, order);
      if (state.catchUp.right) {
        sawCatch = true;
        catchSign = state.eyeOmega.right[2];
      }
    }
    expect(sawCatch).toBe(true);
    expect(catchSign).toBeGreaterThan(100);
    const intact = createState(bundle);
    let intactCatch = false;
    for (let frame = 0; frame < 30; frame += 1) {
      step(bundle, intact, { omegaReidDeg: [0, 0, 200], dt: 1 / 60, ...loss }, order);
      if (intact.catchUp.right) intactCatch = true;
    }
    expect(intactCatch).toBe(false);
  });

  it('keeps acute unilateral nystagmus horizontal, modest, and quick-phase toward the healthy side', () => {
    const loss = { canalScale: { rhc: 0, rac: 0, rpc: 0 } };
    const state = createState(bundle);
    let quickPhase = 0;
    for (let frame = 0; frame < 240; frame += 1) {
      step(bundle, state, { omegaReidDeg: [0, 0, 0], dt: 1 / 60, ...loss }, order);
      if (!state.fastPhase.right && !state.catchUp.right) {
        const slow = state.slowOmega.right;
        expect(slow[2]).toBeLessThan(0);
        expect(Math.abs(slow[2])).toBeGreaterThan(4);
        expect(Math.abs(slow[2])).toBeLessThan(30);
        expect(Math.abs(slow[2])).toBeGreaterThan(Math.abs(slow[0]));
      }
      if (state.fastPhase.right) quickPhase = state.eyeOmega.right[2];
    }
    expect(quickPhase).toBeGreaterThan(0);
  });

  it('lets post-rotatory roll decay ahead of post-rotatory yaw', () => {
    const settle = (omega: Vec3) => {
      const state = createState(bundle);
      for (let frame = 0; frame < 180; frame += 1) step(bundle, state, { omegaReidDeg: omega, dt: 1 / 60 }, order);
      for (let frame = 0; frame < 360; frame += 1) step(bundle, state, { omegaReidDeg: [0, 0, 0], dt: 1 / 60 }, order);
      return state.slowOmega.right;
    };
    const yaw = Math.abs(settle([0, 0, -60])[2]);
    const roll = Math.abs(settle([60, 0, 0])[0]);
    expect(roll).toBeLessThan(yaw);
  });

  it('accepts a canalith bias as an extra cupula deflection', () => {
    const state = run([0, 0, 0], 2, { canalithDegPerSec: { rhc: 40 } });
    expect(state.firing.rhc).toBeGreaterThan(numbers.baseline);
    expect(state.deflection.rhc).toBeGreaterThan(30);
  });
});

describe('pathway highlight', () => {
  it('follows the right horizontal canal through MLF to the agonist muscles', () => {
    const hit = connectedIds(bundle.graph, 'rhc', eyes);
    expect(hit).toEqual(
      expect.arrayContaining(['rhc', 'rvn-h', 'l-vi', 'mlf-rh', 'r-iii-mr', 'l-lr', 'r-mr']),
    );
    expect(hit).not.toContain('r-sr');
    expect(hit).not.toContain('r-so');
    expect(hit).toContain('r-eye');
  });

  it('names the excitatory canal when a muscle is selected', () => {
    expect(excitatoryCanals(bundle.graph, 'r-mr', canalIds)).toEqual(['rhc']);
    expect(excitatoryCanals(bundle.graph, 'l-lr', canalIds)).toEqual(['rhc']);
    expect(excitatoryCanals(bundle.graph, 'r-sr', canalIds)).toEqual(['rac']);
    expect(excitatoryCanals(bundle.graph, 'l-io', canalIds)).toEqual(['rac']);
    expect(excitatoryCanals(bundle.graph, 'l-sr', canalIds)).toEqual(['lac']);
    expect(excitatoryCanals(bundle.graph, 'r-io', canalIds)).toEqual(['lac']);
    expect(excitatoryCanals(bundle.graph, 'r-so', canalIds)).toEqual(['rpc']);
    expect(excitatoryCanals(bundle.graph, 'l-ir', canalIds)).toEqual(['rpc']);
    expect(excitatoryCanals(bundle.graph, 'l-so', canalIds)).toEqual(['lpc']);
    expect(excitatoryCanals(bundle.graph, 'r-ir', canalIds)).toEqual(['lpc']);
    const fromMuscle = connectedIds(bundle.graph, 'r-mr', eyes);
    expect(fromMuscle).toContain('rhc');
  });

  it('keeps the right horizontal excitatory chain apart from the inhibited side', () => {
    const chain = excitatoryChain(bundle.graph, 'rhc', eyes);
    expect(chain).toEqual(expect.arrayContaining(['rhc', 'rvn-h', 'l-vi', 'mlf-rh', 'r-iii-mr', 'r-mr', 'l-lr']));
    expect(chain).not.toContain('lhc');
    expect(chain).not.toContain('r-lr');
    expect(chain).not.toContain('lvn-h');
  });
});
