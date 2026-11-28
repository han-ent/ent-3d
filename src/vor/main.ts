import '../styles/app.css';
import './vor.css';
import { installFonts } from '../shared/fonts';
import { applyI18n, initI18n, onLangChange, t } from '../shared/i18n';
import { anatomyLines, getLabelLang, onLabelLangChange, setLabelLang } from '../shared/label-lang';
import { fetchJson, publicUrl } from '../shared/paths';
import { registerServiceWorker } from '../shared/pwa';
import { renderHeader } from '../shared/ui/chrome';
import { createState, driveOrder, modelNumbers, step, type VorState } from './engine';
import { connectedIds, excitatoryCanals } from './highlight';
import { baselineAfterPinch, dragAngle, ORBIT_VIEWS } from './orbit';
import { VorScene, type LabelCopy } from './scene';
import { renderMeters, renderSheet } from './sheet';
import type { CanalFile, GraphFile, LayoutFile, ParamsFile, Vec3, VorBundle } from './types';

installFonts();
initI18n();
registerServiceWorker();

const query = new URLSearchParams(location.search);
const DEV = query.get('dev') === '1';
const SHOT = query.get('shot') === '1';
const DEMO = query.get('demo');
const EYES = new Set(['r-eye', 'l-eye']);

const header = renderHeader('vor');
document.body.className = 'app-body vor-body';
const workspace = document.createElement('div');
workspace.className = 'vor-workspace';
workspace.innerHTML = `
  <div class="vor-stage">
    <canvas class="vor-gl" id="vor-canvas"></canvas>
    <div class="vor-labels" id="vor-labels"></div>
    <div class="vor-toolbar" id="vor-toolbar">
      <div class="vor-scroll" id="vor-maneuvers"></div>
      <label class="vor-slider"><span data-i18n="vor.velocity"></span><input type="range" id="vor-velocity" min="10" max="300" step="10" value="60"></label>
      <div class="vor-scroll" id="vor-views"></div>
      <div class="vor-scroll" id="vor-drag"></div>
    </div>
    <p class="vor-frame-note" data-i18n="vor.frameNote"></p>
    <canvas class="vor-spark" id="vor-spark" width="168" height="72"></canvas>
    <pre class="vor-dev" id="vor-dev" ${DEV ? '' : 'hidden'}></pre>
    <div class="vor-status" id="vor-status" data-i18n="vor.loading"></div>
  </div>
  <aside class="vor-sheet" id="vor-sheet"></aside>
`;
document.body.replaceChildren(header, workspace);
applyI18n(document.body);
document.title = `${t('vor.title')} · ENT 3D`;

const canvas = workspace.querySelector<HTMLCanvasElement>('#vor-canvas')!;
const labels = workspace.querySelector<HTMLElement>('#vor-labels')!;
const sheet = workspace.querySelector<HTMLElement>('#vor-sheet')!;
const status = workspace.querySelector<HTMLElement>('#vor-status')!;
const spark = workspace.querySelector<HTMLCanvasElement>('#vor-spark')!;
const dev = workspace.querySelector<HTMLElement>('#vor-dev')!;
const velocityInput = workspace.querySelector<HTMLInputElement>('#vor-velocity')!;

const MANEUVERS: { id: string; key: string; axis: Vec3 | 'lac' | 'rac' }[] = [
  { id: 'yaw-left', key: 'vor.yawLeft', axis: [0, 0, 1] },
  { id: 'yaw-right', key: 'vor.yawRight', axis: [0, 0, -1] },
  { id: 'pitch-down', key: 'vor.pitchDown', axis: [0, 1, 0] },
  { id: 'pitch-up', key: 'vor.pitchUp', axis: [0, -1, 0] },
  { id: 'roll-left', key: 'vor.rollLeft', axis: [-1, 0, 0] },
  { id: 'roll-right', key: 'vor.rollRight', axis: [1, 0, 0] },
  { id: 'larp', key: 'vor.larp', axis: 'lac' },
  { id: 'ralp', key: 'vor.ralp', axis: 'rac' },
];

const maneuverHost = workspace.querySelector<HTMLElement>('#vor-maneuvers')!;
maneuverHost.innerHTML = MANEUVERS.map(
  (item) => `<button type="button" data-maneuver="${item.id}" data-i18n="${item.key}"></button>`,
).join('');
const viewHost = workspace.querySelector<HTMLElement>('#vor-views')!;
viewHost.innerHTML = (['head', 'labyrinth', 'brainstem', 'eyes'] as const)
  .map((id) => `<button type="button" data-view="${id}" data-i18n="vor.view.${id}"></button>`)
  .join('');
const dragHost = workspace.querySelector<HTMLElement>('#vor-drag')!;
dragHost.innerHTML = `
  <button type="button" data-drag="view" data-i18n="vor.dragView" aria-pressed="true"></button>
  <button type="button" data-drag="head" data-i18n="vor.dragHead" aria-pressed="false"></button>
`;
applyI18n(workspace);

type DragMode = 'view' | 'head';
type Hypo = 'off' | 'right' | 'left';
type Preset = keyof typeof ORBIT_VIEWS;

let bundle: VorBundle | null = null;
let view: VorScene | null = null;
let state: VorState | null = null;
let order: string[] = [];
let baseline = 90;
let selected: string | null = null;
let preset: Preset = 'head';
let dragMode: DragMode = 'view';
let hypo: Hypo = 'off';
let paused = false;
let speed = 1;
let layoutT = 0;
let layoutTarget = 0;
let maneuver: string | null = SHOT && (DEMO === 'yaw-right' || DEMO === 'eyes') ? 'yaw-right' : null;
let headDrag: Vec3 | null = null;
const history: { rhc: number; lhc: number; eye: number }[] = [];

const pointers = new Map<number, { x: number; y: number }>();
let tracked = { x: 0, y: 0 };
let pinching = false;
let pinchDist = 1;
let press: { x: number; y: number } | null = null;
let dragged = false;

function unit(v: Vec3): Vec3 {
  const scale = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / scale, v[1] / scale, v[2] / scale];
}

function canalNormal(id: string): Vec3 {
  const canal = bundle?.canals.canals.find((item) => item.id === id);
  return canal ? canal.excitatoryNormal : [0, 0, 1];
}

function axisFor(id: string): Vec3 {
  const item = MANEUVERS.find((entry) => entry.id === id);
  if (!item) return [0, 0, 0];
  if (item.axis === 'lac') return unit(canalNormal('lac'));
  if (item.axis === 'rac') return unit(canalNormal('rac'));
  return item.axis;
}

function velocity(): number {
  return Number(velocityInput.value) || 60;
}

function canalScale(): Record<string, number> {
  if (hypo === 'off') return {};
  const ids = hypo === 'right' ? ['rhc', 'rac', 'rpc'] : ['lhc', 'lac', 'lpc'];
  const scale: Record<string, number> = {};
  for (const id of ids) scale[id] = 0;
  return scale;
}

function omegaNow(): Vec3 {
  const drag = headDrag;
  if (drag) return drag;
  if (!maneuver) return [0, 0, 0];
  const axis = axisFor(maneuver);
  const speedDeg = velocity();
  return [axis[0] * speedDeg, axis[1] * speedDeg, axis[2] * speedDeg];
}

function connected(): string[] {
  if (!bundle || !selected) return [];
  return connectedIds(bundle.graph, selected, EYES);
}

function labelList(): string[] {
  if (!bundle) return [];
  if (selected) return [selected, ...connected().filter((id) => id !== selected && id !== 'head')];
  if (preset === 'eyes') return bundle.graph.nodes.filter((node) => node.kind === 'muscle' || node.kind === 'eye').map((node) => node.id);
  if (preset === 'labyrinth') return bundle.canals.canals.map((canal) => canal.id);
  if (preset === 'brainstem') {
    return bundle.graph.nodes.filter((node) => node.kind === 'nucleus' || node.kind === 'tract' || node.id === 'brainstem').map((node) => node.id);
  }
  return [...bundle.canals.canals.map((canal) => canal.id), 'r-eye', 'l-eye', 'brainstem'];
}

function copies(): LabelCopy[] {
  if (!bundle) return [];
  return bundle.graph.nodes.map((node) => ({ id: node.id, lines: anatomyLines(node.nameEn, node.nameKo) }));
}

function refreshLabels(): void {
  view?.setLabels(copies(), labelList());
}

function syncSheetControls(): void {
  sheet.querySelectorAll<HTMLButtonElement>('[data-hypo]').forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.hypo === hypo ? 'true' : 'false');
  });
  const pause = sheet.querySelector<HTMLButtonElement>('[data-pause]');
  if (pause) {
    pause.textContent = t(paused ? 'vor.play' : 'vor.pause');
    pause.setAttribute('aria-pressed', paused ? 'true' : 'false');
  }
  const layout = sheet.querySelector<HTMLButtonElement>('[data-layout]');
  if (layout) layout.textContent = t(layoutTarget > 0.5 ? 'vor.layoutAnatomic' : 'vor.layoutSpread');
  const range = sheet.querySelector<HTMLInputElement>('[data-speed-range]');
  if (range && document.activeElement !== range) range.value = String(speed);
  const speedLabel = sheet.querySelector<HTMLElement>('[data-speed]');
  if (speedLabel) speedLabel.textContent = speedText(speed);
  const en = sheet.querySelector<HTMLInputElement>('[data-label-lang="en"]');
  const ko = sheet.querySelector<HTMLInputElement>('[data-label-lang="ko"]');
  const pref = getLabelLang();
  if (en) en.checked = pref.en;
  if (ko) ko.checked = pref.ko;
}

function refreshSheet(): void {
  if (!bundle || !state) return;
  const canals = selected ? excitatoryCanals(bundle.graph, selected, new Set(bundle.canals.canals.map((canal) => canal.id))) : [];
  renderSheet(
    sheet,
    { bundle, selected, connected: connected(), canals, labels: getLabelLang(), layoutAnatomic: layoutTarget > 0.5 },
    t,
  );
  syncSheetControls();
  renderMeters(sheet, bundle, state, selected, t);
}

function paintChrome(): void {
  document.title = `${t('vor.title')} · ENT 3D`;
  applyI18n(header);
  applyI18n(workspace);
  maneuverHost.querySelectorAll<HTMLButtonElement>('[data-maneuver]').forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.maneuver === maneuver ? 'true' : 'false');
  });
  viewHost.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.view === preset ? 'true' : 'false');
  });
  dragHost.querySelectorAll<HTMLButtonElement>('[data-drag]').forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.drag === dragMode ? 'true' : 'false');
  });
  refreshLabels();
  refreshSheet();
}

function pushHistory(): void {
  if (!state) return;
  history.push({
    rhc: state.firing.rhc ?? 0,
    lhc: state.firing.lhc ?? 0,
    eye: state.eyePos.right[2],
  });
  if (history.length > 180) history.shift();
}

function drawSpark(): void {
  const ctx = spark.getContext('2d');
  if (!ctx) return;
  const w = spark.width;
  const h = spark.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#f7f5f0';
  ctx.fillRect(0, 0, w, h);
  const plot = (key: 'rhc' | 'lhc' | 'eye', color: string, scale: number, mid: number) => {
    ctx.beginPath();
    history.forEach((sample, index) => {
      const x = (index / 179) * w;
      const y = mid - (sample[key] / scale) * (h * 0.42);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  };
  plot('rhc', '#e07a3d', 180, h * 0.55);
  plot('lhc', '#3d7eb5', 180, h * 0.55);
  plot('eye', '#222222', 30, h * 0.5);
}

function drawDev(): void {
  if (!DEV || !state || !bundle) return;
  const lines = bundle.canals.canals.map((canal) => `${canal.id} ${state!.firing[canal.id]?.toFixed(1)}`);
  lines.push(`eyeR ${state.eyePos.right.map((value) => value.toFixed(1)).join(' ')}`);
  lines.push(`slowR ${state.slowOmega.right.map((value) => value.toFixed(1)).join(' ')}`);
  lines.push(state.fastPhase.right ? 'fast' : 'slow');
  dev.textContent = lines.join('\n');
}

function stepOnce(): void {
  if (!bundle || !state || !view) return;
  paused = true;
  const omega = omegaNow();
  step(bundle, state, { omegaReidDeg: omega, dt: 1 / 60, canalScale: canalScale() }, order);
  view.applyHead(omega, 1 / 60);
  pushHistory();
  syncSheetControls();
}

sheet.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button');
  if (!button) return;
  if (button.dataset.jump) {
    selected = button.dataset.jump;
    refreshLabels();
    refreshSheet();
    return;
  }
  if (button.dataset.hypo === 'off' || button.dataset.hypo === 'right' || button.dataset.hypo === 'left') {
    hypo = button.dataset.hypo;
    syncSheetControls();
  }
  if (button.hasAttribute('data-layout')) {
    layoutTarget = layoutTarget > 0.5 ? 0 : 1;
    refreshSheet();
  }
  if (button.hasAttribute('data-pause')) {
    paused = !paused;
    syncSheetControls();
  }
  if (button.hasAttribute('data-step')) stepOnce();
});

sheet.addEventListener('input', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.hasAttribute('data-speed-range')) {
    speed = Number(input.value);
    const speedLabel = sheet.querySelector<HTMLElement>('[data-speed]');
    if (speedLabel) speedLabel.textContent = speedText(speed);
  }
});

sheet.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.dataset.labelLang !== 'en' && input.dataset.labelLang !== 'ko') return;
  const en = sheet.querySelector<HTMLInputElement>('[data-label-lang="en"]');
  const ko = sheet.querySelector<HTMLInputElement>('[data-label-lang="ko"]');
  if (!en || !ko) return;
  const applied = setLabelLang({ en: en.checked, ko: ko.checked });
  en.checked = applied.en;
  ko.checked = applied.ko;
  refreshLabels();
  refreshSheet();
});

maneuverHost.addEventListener('pointerdown', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-maneuver]');
  if (!button) return;
  event.preventDefault();
  maneuver = button.dataset.maneuver ?? null;
  button.setPointerCapture(event.pointerId);
  paintChrome();
});
const releaseManeuver = (event: PointerEvent) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-maneuver]');
  if (!button) return;
  if (maneuver === button.dataset.maneuver && !(SHOT && DEMO)) maneuver = null;
  paintChrome();
};
maneuverHost.addEventListener('pointerup', releaseManeuver);
maneuverHost.addEventListener('pointercancel', releaseManeuver);

viewHost.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-view]');
  const id = button?.dataset.view as Preset | undefined;
  if (!id || !ORBIT_VIEWS[id] || !view) return;
  preset = id;
  view.flyTo(ORBIT_VIEWS[id]);
  paintChrome();
});

dragHost.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-drag]');
  if (button?.dataset.drag === 'view' || button?.dataset.drag === 'head') {
    dragMode = button.dataset.drag;
    headDrag = null;
    paintChrome();
  }
});

canvas.addEventListener('pointerdown', (event) => {
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  canvas.setPointerCapture(event.pointerId);
  if (pointers.size === 1) {
    tracked = { x: event.clientX, y: event.clientY };
    press = { x: event.clientX, y: event.clientY };
    dragged = false;
    view?.setInteracting(true);
  } else {
    const pts = [...pointers.values()];
    pinchDist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y) || 1;
    pinching = true;
    dragged = true;
    headDrag = null;
  }
});

canvas.addEventListener('pointermove', (event) => {
  if (!pointers.has(event.pointerId) || !view) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size >= 2) {
    const pts = [...pointers.values()];
    const dist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y) || 1;
    view.zoomBy(pinchDist / dist);
    pinchDist = dist;
    return;
  }
  const dx = event.clientX - tracked.x;
  const dy = event.clientY - tracked.y;
  if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) dragged = true;
  if (dragMode === 'head') {
    if (Math.hypot(dx, dy) < 0.4) headDrag = [0, 0, 0];
    else {
      const cap = 320;
      const yaw = Math.max(-cap, Math.min(cap, -dx * 6));
      const pitch = Math.max(-cap, Math.min(cap, dy * 6));
      headDrag = [0, pitch, yaw];
    }
  } else {
    view.orbitBy(dragAngle(dx), dragAngle(dy));
  }
  tracked = { x: event.clientX, y: event.clientY };
});

const endPointer = (event: PointerEvent) => {
  if (!pointers.has(event.pointerId)) return;
  pointers.delete(event.pointerId);
  if (pinching && pointers.size < 2) {
    pinching = false;
    const remaining = [...pointers.values()][0];
    if (remaining) tracked = baselineAfterPinch(tracked, remaining).point;
    headDrag = null;
    return;
  }
  if (pointers.size > 0) return;
  view?.setInteracting(false);
  headDrag = null;
  if (!dragged && press) {
    const hit = view?.pick(event.clientX, event.clientY) ?? null;
    selected = hit === 'head' ? null : hit;
    refreshLabels();
    refreshSheet();
  }
  press = null;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

labels.addEventListener('click', (event) => {
  const el = (event.target as HTMLElement).closest<HTMLElement>('.vor-label');
  const id = el?.dataset.nodeId;
  if (!id) return;
  selected = id;
  refreshLabels();
  refreshSheet();
});

let acc = 0;
let last = performance.now();

function frame(now: number): void {
  const real = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (layoutT < layoutTarget) layoutT = Math.min(layoutTarget, layoutT + real / 0.75);
  if (layoutT > layoutTarget) layoutT = Math.max(layoutTarget, layoutT - real / 0.75);
  if (bundle && state && view) {
    const omega = omegaNow();
    if (!paused) {
      acc += real * speed;
      let steps = 0;
      while (acc >= 1 / 60 && steps < 4) {
        step(bundle, state, { omegaReidDeg: omega, dt: 1 / 60, canalScale: canalScale() }, order);
        view.applyHead(omega, 1 / 60);
        acc -= 1 / 60;
        steps += 1;
        pushHistory();
      }
    }
    view.setLayout(layoutT);
    view.applyState(state, selected ? new Set(connected()) : null, baseline);
    view.render(now);
    renderMeters(sheet, bundle, state, selected, t);
    drawSpark();
    drawDev();
  }
  requestAnimationFrame(frame);
}

onLangChange(paintChrome);
onLabelLangChange(() => {
  refreshLabels();
  refreshSheet();
});

async function boot(): Promise<void> {
  try {
    const [canals, graph, params, layout] = await Promise.all([
      fetchJson<CanalFile>(publicUrl('vor/canals.json')),
      fetchJson<GraphFile>(publicUrl('vor/graph.json')),
      fetchJson<ParamsFile>(publicUrl('vor/params.json')),
      fetchJson<LayoutFile>(publicUrl('vor/layout.json')),
    ]);
    bundle = { canals, graph, params, layout };
    order = driveOrder(graph);
    baseline = modelNumbers(params).baseline;
    state = createState(bundle);
    view = new VorScene(canvas, labels, bundle);
    status.hidden = true;
    if (window.innerHeight < 780) view.flyTo({ ...ORBIT_VIEWS.head, radius: 370 }, false);
    if (SHOT && DEMO === 'highlight-rhc') {
      selected = 'rhc';
      preset = 'labyrinth';
      const close = window.innerWidth < 800 ? { ...ORBIT_VIEWS.labyrinth, radius: 130, target: [36, 4, 6] as [number, number, number] } : ORBIT_VIEWS.labyrinth;
      view.flyTo(close, false);
    }
    if (SHOT && DEMO === 'eyes') {
      preset = 'eyes';
      view.flyTo(ORBIT_VIEWS.eyes, false);
      velocityInput.value = '50';
    }
    if (SHOT && (DEMO === 'yaw-right' || DEMO === 'eyes')) {
      const omega: Vec3 = [0, 0, DEMO === 'eyes' ? -50 : -80];
      for (let i = 0; i < 14; i += 1) {
        step(bundle, state, { omegaReidDeg: omega, dt: 1 / 60 }, order);
        view.applyHead(omega, 1 / 60);
        pushHistory();
      }
    }
    window.addEventListener('resize', () => view?.resize());
    paintChrome();
    requestAnimationFrame(frame);
  } catch {
    status.textContent = t('vor.loadError');
  }
}

void boot();

function speedText(value: number): string {
  return `${Number(value.toFixed(2))}×`;
}
