import '../styles/app.css';
import { anatomicalPlaneName, ctDisplayOrient, displayedEdgeLabels, displayedSize, mapDisplayToRaw, mapRawToDisplay } from '../shared/frame';
import { dedupeStudyLabels, displayEnglish, englishFirst, type LabelMode, type StudyLabel } from '../shared/labels';
import { buildSearchIndex, searchEntries, type SearchEntry, type TermRecord } from '../shared/search-index';
import { ctPanelVisible, nextSnap, sheetCoverPx, snapAfterDrag, type SheetSnap } from '../shared/sheet-snap';
import {
  frameAabb,
  hiddenForStage,
  STAGE_VIEW,
  stagesForLandmark,
  stepsForLabel,
  structureStages,
  SURGICAL_STRUCTURES,
  type ViewStage,
} from '../shared/stage-frame';
import { CANAL_WALL } from '../shared/surface-anchor';
import { contoursOnPlane, indexAlong, movePointToSlice, pointOnSlice, remapGray, sliceFractions, type SliceName } from '../shared/ct-slice';
import { sliceFile, slicePose, clampIndex } from '../shared/ct';
import { firstLine, isPendingText, paragraphLines, sentenceNeedsSourceCheck } from '../shared/content-display';
import { installFonts } from '../shared/fonts';
import { applyI18n, getLang, initI18n, onLangChange, t, text } from '../shared/i18n';
import { distanceMm, formatDistanceMm } from '../shared/measurement';
import { assetUrl, fetchJson, publicUrl } from '../shared/paths';
import { registerServiceWorker } from '../shared/pwa';
import { grade, makeLocateQuestion, makeNameQuestion, type QuizQuestion } from '../shared/quiz';
import { formatIssues, validateContent, validateManifest, validatePresets, validateVolume } from '../shared/schema';
import { STRUCTURE_SYSTEMS } from '../shared/systems';
import type { DissectionStep, Manifest, PresetFile, StructureContent, StructureDef, Vec3, VolumeMeta } from '../shared/types';
import { renderHeader } from '../shared/ui/chrome';
import { EntViewer, type PickHit } from '../shared/viewer/Viewer';

const DATA = 'temporal-bone';
const QUIZ_LENGTH = 5;
const params = new URLSearchParams(location.search);
const DEV = params.get('dev') === '1';
const SHOT = params.get('shot') === '1';

type QuizState = {
  kind: 'name' | 'locate';
  question: QuizQuestion;
  score: number;
  total: number;
  answered: boolean;
  feedback: string;
  finished: boolean;
};

installFonts();
initI18n();
registerServiceWorker();

const header = renderHeader('temporal');
const workspace = document.createElement('div');
workspace.className = 'workspace';
workspace.innerHTML = `
  <div class="stage">
    <canvas id="view"></canvas>
    <div class="stage-status" id="stage-status" data-i18n="temporal.loading"></div>
    <div class="scale-hud" id="scale-hud">
      <span class="scale-bar-line" data-scale-line></span>
      <span data-scale-label>10 mm</span>
    </div>
    <div class="labelbar" id="labelbar" role="toolbar">
      <button type="button" data-labels="basic" data-i18n="labels.basic"></button>
      <button type="button" data-labels="surgical" data-i18n="labels.surgical"></button>
      <button type="button" data-labels="all" data-i18n="labels.all"></button>
    </div>
    <div class="crumbs" id="crumbs"></div>
    <div class="measure-card" id="measure-readout" hidden>
      <div id="measure-text"></div>
      <button type="button" id="measure-clear" data-i18n="measure.clear"></button>
    </div>
    <p class="stage-caption" id="stage-caption"></p>
    <div class="modebar" role="toolbar">
      <button type="button" data-mode="view" data-dev-only data-i18n="mode.view"></button>
      <button type="button" data-mode="measure" data-dev-only data-i18n="mode.measure"></button>
      <button type="button" data-mode="quiz" data-dev-only data-i18n="mode.quiz"></button>
      <button type="button" id="frame-btn" data-i18n="mode.frame"></button>
      <button type="button" id="bone-btn" data-i18n="bone.transparent"></button>
      <button type="button" id="style-btn"></button>
    </div>
  </div>
  <section class="sheet" id="sheet">
    <button type="button" class="sheet-handle" id="sheet-toggle" aria-expanded="false">
      <span class="grip"></span>
      <span class="sr-only" data-i18n="sheet.expand"></span>
    </button>
    <div class="peek">
      <h2 id="peek-title"></h2>
      <p id="peek-line"></p>
      <div class="peek-actions" id="peek-actions"></div>
    </div>
    <div class="sheet-body" id="sheet-body">
      <p class="review-line" data-i18n="sheet.reviewLine"></p>
      <div id="info-body"></div>
      <section>
        <h3 data-i18n="sheet.structures"></h3>
        <input class="struct-search" id="structure-search" type="search" data-i18n-aria="sheet.search" />
        <div id="structure-list"></div>
      </section>
      <section>
        <h3 data-i18n="presets.title"></h3>
        <p class="hint" data-i18n="presets.note"></p>
        <div class="btn-row" id="sequence-row"></div>
        <div id="step-list"></div>
        <div id="step-detail"></div>
      </section>
      <section>
        <h3 data-i18n="ct.title"></h3>
        <p class="hint" data-i18n="ct.hint"></p>
        <div class="btn-row" id="ct-planes"></div>
        <div class="ct-orient" id="ct-orient-top"></div>
        <canvas class="ct-canvas" id="ct-canvas"></canvas>
        <div class="ct-orient" id="ct-orient-bottom"></div>
        <p class="meta" id="ct-readout"></p>
        <label class="checkline"><span data-i18n="ct.window"></span><input id="ct-window" type="range" min="20" max="400" value="255" /></label>
        <label class="checkline"><span data-i18n="ct.level"></span><input id="ct-level" type="range" min="0" max="255" value="128" /></label>
        <input id="ct-index" type="range" min="0" max="1" value="0" data-i18n-aria="ct.slice" />
        <label class="checkline"><input id="ct-contour" type="checkbox" checked /><span data-i18n="ct.contour"></span></label>
        <label class="checkline"><input id="ct-float" type="checkbox" /><span data-i18n="ct.overlay"></span></label>
      </section>
      <section id="quiz-card" hidden>
        <h3 data-i18n="quiz.title"></h3>
        <div class="btn-row">
          <button type="button" class="text-btn" id="quiz-name" data-i18n="quiz.nameMode"></button>
          <button type="button" class="text-btn" id="quiz-locate" data-i18n="quiz.locateMode"></button>
        </div>
        <div id="quiz-body"></div>
        <button type="button" class="text-btn" id="quiz-exit" data-i18n="quiz.exit"></button>
      </section>
      <section id="dev-card" hidden>
        <h3 data-i18n="dev.title"></h3>
        <div id="dev-body"></div>
      </section>
    </div>
  </section>
`;

  document.body.className = 'app-body';
document.body.replaceChildren(header, workspace);

const canvas = workspace.querySelector<HTMLCanvasElement>('#view')!;
const stageStatus = workspace.querySelector<HTMLElement>('#stage-status')!;
const measureReadout = workspace.querySelector<HTMLElement>('#measure-readout')!;
const measureText = workspace.querySelector<HTMLElement>('#measure-text')!;
const stageCaption = workspace.querySelector<HTMLElement>('#stage-caption')!;
const sheet = workspace.querySelector<HTMLElement>('#sheet')!;
const sheetToggle = workspace.querySelector<HTMLButtonElement>('#sheet-toggle')!;
const peekTitle = workspace.querySelector<HTMLElement>('#peek-title')!;
const peekLine = workspace.querySelector<HTMLElement>('#peek-line')!;
const peekActions = workspace.querySelector<HTMLElement>('#peek-actions')!;
const infoBody = workspace.querySelector<HTMLElement>('#info-body')!;
const searchInput = workspace.querySelector<HTMLInputElement>('#structure-search')!;
const structureList = workspace.querySelector<HTMLElement>('#structure-list')!;
const sequenceRow = workspace.querySelector<HTMLElement>('#sequence-row')!;
const stepList = workspace.querySelector<HTMLElement>('#step-list')!;
const stepDetail = workspace.querySelector<HTMLElement>('#step-detail')!;
const ctPlanes = workspace.querySelector<HTMLElement>('#ct-planes')!;
const ctCanvas = workspace.querySelector<HTMLCanvasElement>('#ct-canvas')!;
const ctReadout = workspace.querySelector<HTMLElement>('#ct-readout')!;
const ctOrientTop = workspace.querySelector<HTMLElement>('#ct-orient-top')!;
const ctOrientBottom = workspace.querySelector<HTMLElement>('#ct-orient-bottom')!;
const quizCard = workspace.querySelector<HTMLElement>('#quiz-card')!;
const quizBody = workspace.querySelector<HTMLElement>('#quiz-body')!;
const devCard = workspace.querySelector<HTMLElement>('#dev-card')!;
const devBody = workspace.querySelector<HTMLElement>('#dev-body')!;
const boneBtn = workspace.querySelector<HTMLButtonElement>('#bone-btn')!;
const styleBtn = workspace.querySelector<HTMLButtonElement>('#style-btn')!;

let manifest: Manifest | null = null;
let contents = new Map<string, StructureContent>();
let presets: PresetFile | null = null;
let volume: VolumeMeta | null = null;
let viewer: EntViewer | null = null;
type XyzItem = {
  id: string;
  parent?: string;
  en: string;
  ko: string;
  anatomy: string;
  clinical: string;
  sources: { citation: string; page: string; verified: boolean }[];
  review: string;
  xyz_mm: [number, number, number];
  surgical?: boolean;
  tier?: string;
  confidence?: string;
};
type CtAnnotation = XyzItem & { plane: SliceName; slice_index: number; xy: [number, number] };
type RegistrationFile = {
  review: string;
  scaleDecision: string;
  current: {
    rmsMm: number;
    pairs: {
      id: string;
      en: string;
      ko: string;
      residualMm: number;
      zetaMm: [number, number, number];
      skullMm: [number, number, number];
    }[];
  };
  umeyama: { scale: number; rmsMm: number };
  umeyamaWithoutMastoid?: { scale: number; rmsMm: number };
};
let registration: RegistrationFile | null = null;
let registrationShown = false;
let landmarks: XyzItem[] = [];
let surfaceLabels: XyzItem[] = [];
let ctLabels: CtAnnotation[] = [];
let labelMode: LabelMode = 'basic';
let searchIndex: SearchEntry[] = [];
let sheetSnap: SheetSnap = 'peek';
const rawCanvas = document.createElement('canvas');
let renderStyle: 'atlas' | 'model' = params.get('style') === 'model' ? 'model' : 'atlas';
let eacMm: [number, number, number] | null = null;
let stageName = '';
let devLandmark: string | null = null;
let mode: 'view' | 'measure' | 'quiz' = 'view';
let selected: string | null = null;
let activeSequence = '';
let activeStep: string | null = null;
let quiz: QuizState | null = null;
let activePlane: SliceName = 'axial';
let crosshair: Vec3 | null = null;
let contoursOn = true;
let floatPlanes = false;
const planeState: Record<SliceName, { index: number }> = {
  axial: { index: 0 },
  coronal: { index: 0 },
  sagittal: { index: 0 },
};
const imageCache = new Map<string, Promise<HTMLImageElement>>();
const rawCache = new Map<string, ImageData>();

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[char] ?? char;
  });
}

function contentOf(id: string): StructureContent | undefined {
  return contents.get(id);
}

function structureById(id: string): StructureDef | undefined {
  return manifest?.structures.find((item) => item.id === id);
}

function structureLabel(id: string): string {
  const structure = structureById(id);
  if (!structure) return id;
  return englishFirst(structure.name.en, structure.name.ko);
}

function findStep(id: string): DissectionStep | undefined {
  for (const sequence of presets?.sequences ?? []) {
    const step = sequence.steps.find((item) => item.id === id);
    if (step) return step;
  }
  return undefined;
}

function desktopLayout(): boolean {
  return window.matchMedia('(min-width: 960px)').matches;
}

function applySnap(snap: SheetSnap): void {
  sheetSnap = snap;
  const desktop = desktopLayout();
  const cover = desktop ? 0 : sheetCoverPx(snap, window.innerHeight);
  document.documentElement.style.setProperty('--sheet-cover', `${cover}px`);
  sheet.dataset.snap = desktop ? 'full' : snap;
  document.body.classList.toggle('is-sheet-full', !desktop && snap === 'full');
  const open = desktop || snap !== 'peek';
  sheet.classList.toggle('is-open', open);
  sheetToggle.setAttribute('aria-expanded', String(open));
  sheetToggle.setAttribute('aria-label', open ? t('sheet.collapse') : t('sheet.expand'));
  syncCrosshair();
  requestAnimationFrame(() => {
    syncLabelInset();
    refitForSheet();
  });
}

function openSheet(open: boolean): void {
  applySnap(open ? (sheetSnap === 'peek' ? 'half' : sheetSnap) : 'peek');
}

function syncCrosshair(): void {
  const show = ctPanelVisible(sheetSnap, desktopLayout()) && crosshair ? crosshair : null;
  viewer?.setCrosshair(show);
}

function syncLabelInset(): void {
  if (!viewer) return;
  const stageEl = workspace.querySelector('.stage');
  if (!stageEl) return;
  const stageRect = stageEl.getBoundingClientRect();
  let freeTop = stageRect.top;
  let freeRight = stageRect.right;
  let freeBottom = stageRect.bottom;
  let freeLeft = stageRect.left;
    for (const node of workspace.querySelectorAll('.labelbar, .gizmo, .modebar, .crumbs, .scale-hud, .stage-caption, #sheet')) {
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (rect.right < stageRect.left + 8 || rect.left > stageRect.right - 8) continue;
    if (rect.bottom < stageRect.top + 8 || rect.top > stageRect.bottom - 8) continue;
    if (rect.top < stageRect.top + stageRect.height * 0.5) freeTop = Math.max(freeTop, Math.min(rect.bottom, stageRect.bottom));
    if (rect.bottom > stageRect.bottom - stageRect.height * 0.72) freeBottom = Math.min(freeBottom, Math.max(rect.top, stageRect.top));
    if (rect.left > stageRect.left + stageRect.width * 0.55) freeRight = Math.min(freeRight, rect.left);
    if (rect.right < stageRect.left + stageRect.width * 0.45) freeLeft = Math.max(freeLeft, rect.left);
  }
  viewer.setLabelInset({
    top: Math.max(8, freeTop - stageRect.top + 6),
    right: Math.max(8, stageRect.right - freeRight + 6),
    bottom: Math.max(8, stageRect.bottom - freeBottom + 6),
    left: Math.max(8, freeLeft - stageRect.left + 6),
  });
}

function paintStatic(): void {
  document.title = `${t('temporal.title')} · ENT 3D`;
  applyI18n(document.body);
  searchInput.placeholder = t('sheet.search');
  searchInput.setAttribute('aria-label', t('sheet.search'));
  for (const button of workspace.querySelectorAll<HTMLButtonElement>('button')) {
    const name = button.textContent?.replace(/\s+/g, ' ').trim();
    if (name && !button.getAttribute('aria-label')) button.setAttribute('aria-label', name);
  }
  sheetToggle.setAttribute('aria-label', sheet.classList.contains('is-open') ? t('sheet.collapse') : t('sheet.expand'));
  workspace.querySelectorAll<HTMLElement>('[data-dev-only]').forEach((node) => {
    node.hidden = !DEV;
  });
  boneBtn.textContent = viewer?.boneIsTransparent() ? t('bone.solid') : t('bone.transparent');
  boneBtn.setAttribute('aria-label', boneBtn.textContent ?? '');
  workspace.querySelectorAll<HTMLButtonElement>('[data-labels]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.labels === labelMode));
  });
  renderCrumbs();
  boneBtn.setAttribute('aria-pressed', String(viewer?.boneIsTransparent() === true));
  styleBtn.textContent = renderStyle === 'atlas' ? t('style.atlas') : t('style.model');
  styleBtn.setAttribute('aria-label', styleBtn.textContent ?? '');
  styleBtn.setAttribute('aria-pressed', String(renderStyle === 'atlas'));
  for (const structure of manifest?.structures ?? []) viewer?.setLabel(structure.id, structureLabel(structure.id));
  renderMeasure(viewer?.measurementPoints() ?? []);
  renderPeek();
  renderInfo();
  renderChips();
  renderPresets();
  renderQuiz();
  renderDev();
  renderOrient();
}

function renderMeasure(points: Vec3[]): void {
  measureReadout.hidden = mode !== 'measure';
  if (points.length === 0) measureText.textContent = t('measure.hint');
  else if (points.length === 1) measureText.textContent = t('measure.needSecond');
  else measureText.textContent = `${t('measure.result')} ${formatDistanceMm(distanceMm(points[0]!, points[1]!))}`;
}

function renderPeek(): void {
  const structure = selected ? structureById(selected) : undefined;
  const content = selected ? contentOf(selected) : undefined;
  const step = activeStep ? findStep(activeStep) : undefined;
  if (mode === 'quiz') {
    peekTitle.textContent = t('quiz.title');
    peekLine.textContent = quiz?.question.mode === 'locate' ? quiz.question.label : t('quiz.promptName');
  } else if (structure) {
    peekTitle.textContent = structureLabel(structure.id);
    const fn = content ? text(content.function) : '';
    peekLine.textContent = isPendingText(fn) ? t('sheet.pending') : firstLine(fn);
  } else if (step) {
    peekTitle.textContent = text(step.title);
    peekLine.textContent = firstLine(text(step.instructions));
  } else {
    peekTitle.textContent = t('sheet.emptyTitle');
    peekLine.textContent = t('sheet.emptyLine');
  }
  peekActions.replaceChildren();
  stageCaption.textContent = mode === 'quiz' ? '' : captionFor(step);
  if (!selected || mode === 'quiz') return;
  const isolate = document.createElement('button');
  isolate.type = 'button';
  const isolated = viewer?.isolatedId() === selected;
  isolate.textContent = isolated ? t('sheet.isolateOff') : t('sheet.isolate');
  isolate.setAttribute('aria-pressed', String(isolated));
  isolate.addEventListener('click', () => {
    viewer?.setIsolate(isolated ? null : selected);
    renderPeek();
    renderChips();
  });
  const hide = document.createElement('button');
  hide.type = 'button';
  hide.textContent = t('sheet.hide');
  hide.addEventListener('click', () => {
    if (!selected) return;
    viewer?.setHidden(selected, true);
    selected = null;
    renderPeek();
    renderInfo();
    renderChips();
  });
  peekActions.append(isolate, hide);
}

function paragraphHtml(value: string, review: StructureContent['review']): string {
  if (isPendingText(value)) return `<p class="pending">${escapeHtml(t('sheet.pending'))}</p>`;
  return paragraphLines(value)
    .map((line) => {
      const dot = review === '미검증' ? '<i class="review-dot" aria-hidden="true"></i>' : '';
      const mark = sentenceNeedsSourceCheck(line)
        ? `<span class="source-check">${escapeHtml(t('sheet.sourceCheck'))}</span>`
        : '';
      return `<p>${dot}${escapeHtml(line)}${mark}</p>`;
    })
    .join('');
}

function renderInfo(): void {
  if (mode === 'quiz') {
    infoBody.innerHTML = '';
    return;
  }
  const structure = selected ? structureById(selected) : undefined;
  const content = selected ? contentOf(selected) : undefined;
  if (!structure || !content) {
    infoBody.innerHTML = `<p class="hint">${escapeHtml(t('info.empty'))}</p>`;
    return;
  }
  const anatomy = text(content.anatomy);
  const fn = text(content.function);
  if (isPendingText(anatomy) && isPendingText(fn) && content.surgical_points.length === 0) {
    infoBody.innerHTML = `<p class="pending">${escapeHtml(t('sheet.pending'))}</p>`;
    return;
  }
  const points = content.surgical_points
    .filter((point) => !isPendingText(text(point.text)))
    .map((point) => paragraphHtml(text(point.text), point.review ?? content.review))
    .join('');
  const sources = content.sources
    .map((source) => {
      const mark = source.verified ? '' : `<span class="source-check">${escapeHtml(t('sheet.sourceCheck'))}</span>`;
      return `<p class="source-line">${escapeHtml(source.citation)} · ${escapeHtml(source.page)}${mark}</p>`;
    })
    .join('');
  const related = (content.related ?? [])
    .map((id) => {
      const linked = structureById(id);
      const label = linked ? text(linked.name) : id;
      return `<button type="button" class="text-btn" data-related="${escapeHtml(id)}">${escapeHtml(label)}</button>`;
    })
    .join('');
  infoBody.innerHTML = `
    <h3>${escapeHtml(t('info.summary'))}</h3>
    ${paragraphHtml(anatomy, content.review)}
    <h3>${escapeHtml(t('info.function'))}</h3>
    ${paragraphHtml(fn, content.review)}
    ${points ? `<h3>${escapeHtml(t('info.points'))}</h3>${points}` : ''}
    ${related ? `<h3>${escapeHtml(t('info.related'))}</h3><div class="btn-row">${related}</div><p class="hint">${escapeHtml(t('info.relatedHint'))}</p>` : ''}
    ${sources ? `<h3>${escapeHtml(t('info.source'))}</h3>${sources}` : ''}
  `;
  infoBody.querySelectorAll<HTMLButtonElement>('[data-related]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.related ?? '';
      if (id && mode !== 'quiz') selectStructure(id, true);
    });
  });
}

function renderChips(): void {
  if (!manifest) return;
  const query = searchInput.value.trim();
  const hits = query ? searchEntries(searchIndex, query) : null;
  const structureHits = hits ? new Set(hits.filter((hit) => hit.kind === 'structure').map((hit) => hit.id)) : null;
  structureList.replaceChildren();
  const hidden = new Set(viewer?.hiddenIds() ?? []);
  for (const system of STRUCTURE_SYSTEMS) {
    const items = manifest.structures.filter((structure) => {
      if (!system.ids.includes(structure.id)) return false;
      if (!structureHits) return true;
      return structureHits.has(structure.id);
    });
    if (items.length === 0) continue;
    const heading = document.createElement('h3');
    heading.className = 'group-label';
    heading.textContent = text(system.name);
    structureList.append(heading);
    for (const structure of items) {
      const row = document.createElement('div');
      row.className = 'chip-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.dataset.select = structure.id;
      if (structure.id === selected) button.classList.add('is-active');
      button.innerHTML = `<i class="swatch" style="background:${structure.color}"></i><span>${escapeHtml(structureLabel(structure.id))}</span>`;
      button.addEventListener('click', () => {
        if (mode === 'quiz') return;
        setMode('view');
        viewer?.flash(structure.id);
        selectStructure(structure.id, true);
      });
      const hide = document.createElement('button');
      hide.type = 'button';
      hide.className = 'hide-btn';
      hide.dataset.hide = structure.id;
      hide.textContent = hidden.has(structure.id) ? t('sheet.show') : t('sheet.hide');
      hide.setAttribute('aria-label', `${hide.textContent} ${structureLabel(structure.id)}`);
      hide.addEventListener('click', () => {
        const next = !hidden.has(structure.id);
        viewer?.setHidden(structure.id, next);
        if (next && selected === structure.id) selected = null;
        renderPeek();
        renderInfo();
        renderChips();
      });
      row.append(button, hide);
      structureList.append(row);
    }
  }
  const listed = new Set<string>();
  structureList.querySelectorAll<HTMLElement>('[data-select]').forEach((node) => {
    if (node.dataset.select) listed.add(node.dataset.select);
  });
  const extraHits = (hits ?? []).filter((hit) => !listed.has(hit.id) && hit.kind === 'structure');
  if (extraHits.length) {
    for (const hit of extraHits) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip landmark-hit';
      button.textContent = englishFirst(hit.en, hit.ko);
      button.setAttribute('aria-label', button.textContent);
      button.addEventListener('click', () => {
        if (mode === 'quiz') return;
        setMode('view');
        const parent = hit.id === 'cochlea' ? 'scala-vestibuli' : hit.parentId;
        if (parent && structureById(parent)) selectStructure(parent, true);
      });
      structureList.append(button);
    }
  }
  const landmarkHits = hits?.filter((hit) => hit.kind === 'landmark') ?? [];
  if (landmarkHits.length) {
    const heading = document.createElement('h3');
    heading.className = 'group-label';
    heading.textContent = t('sheet.landmarks');
    structureList.append(heading);
    for (const hit of landmarkHits) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip landmark-hit';
      button.textContent = englishFirst(hit.en, hit.ko);
      button.setAttribute('aria-label', button.textContent);
      button.addEventListener('click', () => {
        if (mode === 'quiz') return;
        setMode('view');
        if (hit.parentId && structureById(hit.parentId)) selectStructure(hit.parentId, true);
      });
      structureList.append(button);
    }
  }
}

function renderPresets(): void {
  sequenceRow.querySelectorAll<HTMLButtonElement>('[data-sequence]').forEach((button) => {
    const id = button.dataset.sequence ?? '';
    const sequence = presets?.sequences.find((item) => item.id === id);
    if (sequence) button.textContent = text(sequence.title);
    button.classList.toggle('is-active', id === activeSequence);
  });
  stepList.querySelectorAll<HTMLButtonElement>('[data-step]').forEach((button) => {
    const step = findStep(button.dataset.step ?? '');
    const title = button.querySelector('[data-step-title]');
    if (step && title) title.textContent = text(step.title);
    button.classList.toggle('is-active', button.dataset.step === activeStep);
  });
  renderStepDetail();
}

function namesHtml(ids: string[]): string {
  if (ids.length === 0) return `<p class="hint">${escapeHtml(t('presets.none'))}</p>`;
  return `<div class="btn-row">${ids
    .map((id) => `<button type="button" class="text-btn" data-step-structure="${escapeHtml(id)}">${escapeHtml(text(structureById(id)?.name) || id)}</button>`)
    .join('')}</div>`;
}

function captionFor(step: DissectionStep | undefined): string {
  if (!step) return '';
  if (step.clipping?.enabled) return t('presets.viewPresetShort');
  return text(step.title);
}

function renderStepDetail(): void {
  const step = activeStep ? findStep(activeStep) : undefined;
  if (!step) {
    stepDetail.replaceChildren();
    stageCaption.textContent = '';
    return;
  }
  const viewPreset = step.clipping?.enabled ? t('presets.viewPreset') : '';
  stageCaption.textContent = captionFor(step);
  const marker = step.marker
    ? `<h3>${escapeHtml(t('presets.marker'))}</h3><p>${escapeHtml(text(step.marker.label))} · ${escapeHtml(step.marker.review)}</p><p class="source-line">${escapeHtml(step.marker.source)}</p>`
    : '';
  stepDetail.innerHTML = `
    <p>${escapeHtml(text(step.instructions))}</p>
    ${viewPreset ? `<p class="hint">${escapeHtml(viewPreset)}</p>` : ''}
    <h3>${escapeHtml(t('presets.identify'))}</h3>
    ${namesHtml(step.identify)}
    <h3>${escapeHtml(t('presets.danger'))}</h3>
    ${namesHtml(step.danger)}
    ${marker}
  `;
  stepDetail.querySelectorAll<HTMLButtonElement>('[data-step-structure]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.stepStructure ?? '';
      if (id && mode !== 'quiz') selectStructure(id, true);
    });
  });
}

function renderQuiz(): void {
  quizCard.hidden = mode !== 'quiz';
  if (!quiz) {
    quizBody.innerHTML = '';
    return;
  }
  if (quiz.finished) {
    quizBody.innerHTML = `
      <p>${escapeHtml(t('quiz.done'))}</p>
      <p>${escapeHtml(t('quiz.score', { score: quiz.score, total: quiz.total }))}</p>
      <button type="button" class="text-btn" id="quiz-again">${escapeHtml(t('quiz.again'))}</button>
    `;
    quizBody.querySelector('#quiz-again')?.addEventListener('click', () => startQuiz(quiz!.kind));
    return;
  }
  const score = `<p class="meta">${escapeHtml(t('quiz.score', { score: quiz.score, total: quiz.total }))}</p>`;
  if (quiz.question.mode === 'name') {
    const choices = quiz.question.choices
      .map((choice) => {
        const mark = quiz!.answered && choice.id === quiz!.question.structureId ? ' is-correct' : '';
        return `<button type="button" class="choice${mark}" data-choice="${escapeHtml(choice.id)}" ${quiz!.answered ? 'disabled' : ''}>${escapeHtml(choice.label)}</button>`;
      })
      .join('');
    quizBody.innerHTML = `
      ${score}
      <p>${escapeHtml(t('quiz.promptName'))}</p>
      <div>${choices}</div>
      <p>${escapeHtml(quiz.feedback)}</p>
      ${quiz.answered ? `<button type="button" class="text-btn" id="quiz-next">${escapeHtml(t('quiz.next'))}</button>` : ''}
    `;
    quizBody.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach((button) => {
      button.addEventListener('click', () => answerQuiz(button.dataset.choice ?? ''));
    });
  } else {
    quizBody.innerHTML = `
      ${score}
      <p>${escapeHtml(t('quiz.promptLocate'))}</p>
      <p><strong>${escapeHtml(quiz.question.label)}</strong></p>
      <p>${escapeHtml(quiz.feedback)}</p>
      ${quiz.answered ? `<button type="button" class="text-btn" id="quiz-next">${escapeHtml(t('quiz.next'))}</button>` : ''}
    `;
  }
  quizBody.querySelector('#quiz-next')?.addEventListener('click', nextQuestion);
}

function renderOrient(): void {
  const labels = displayedEdgeLabels(activePlane);
  ctOrientTop.innerHTML = `<span>${labels.left}</span><span>${labels.top}</span><span>${labels.right}</span>`;
  ctOrientBottom.innerHTML = `<span></span><span>${labels.bottom}</span><span></span>`;
}

function setMode(next: 'view' | 'measure' | 'quiz'): void {
  mode = next;
  document.body.classList.toggle('is-quiz', next === 'quiz');
  viewer?.setMode(next);
  workspace.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.mode === next));
  });
  if (next !== 'quiz') {
    quiz = null;
    if (selected) viewer?.select(selected, false);
    else viewer?.highlight(null, false);
  }
  renderMeasure(viewer?.measurementPoints() ?? []);
  renderQuiz();
  renderPeek();
  renderInfo();
}

function selectStructure(id: string, frame: boolean): void {
  selected = id;
  const structure = structureById(id);
  if (structure) viewer?.setHidden(id, false);
  viewer?.flash(id);
  viewer?.select(id, frame);
  const sheetBody = document.querySelector<HTMLElement>('#sheet-body');
  if (sheetBody) sheetBody.scrollTop = 0;
  renderPeek();
  renderInfo();
  renderChips();
}

function answerQuiz(id: string): void {
  if (!quiz || quiz.answered || quiz.finished) return;
  const correct = grade(quiz.question, id);
  quiz.answered = true;
  quiz.total += 1;
  if (correct) quiz.score += 1;
  quiz.feedback = correct ? t('quiz.correct') : t('quiz.wrong');
  viewer?.highlight(quiz.question.structureId, true, true, 42, true);
  if (quiz.total >= QUIZ_LENGTH) quiz.finished = true;
  renderQuiz();
}

function nextQuestion(): void {
  if (!manifest || !quiz) return;
  if (quiz.total >= QUIZ_LENGTH) {
    quiz.finished = true;
    renderQuiz();
    return;
  }
  const items = manifest.structures.map((structure) => ({ id: structure.id, name: structure.name }));
  const previous = quiz.question.structureId;
  let question = quiz.kind === 'name' ? makeNameQuestion(items, getLang()) : makeLocateQuestion(items, getLang());
  if (items.length > 1 && question.structureId === previous) {
    question = quiz.kind === 'name' ? makeNameQuestion(items, getLang()) : makeLocateQuestion(items, getLang());
  }
  quiz.question = question;
  quiz.answered = false;
  quiz.feedback = '';
  quiz.finished = false;
  if (question.mode === 'name') viewer?.highlight(question.structureId, true, true, 42, true);
  else viewer?.highlight(null, false);
  renderQuiz();
}

function startQuiz(kind: 'name' | 'locate'): void {
  if (!manifest) return;
  const items = manifest.structures.map((structure) => ({ id: structure.id, name: structure.name }));
  const question = kind === 'name' ? makeNameQuestion(items, getLang()) : makeLocateQuestion(items, getLang());
  activeStep = null;
  quiz = { kind, question, score: 0, total: 0, answered: false, feedback: '', finished: false };
  setMode('quiz');
  openSheet(true);
  if (question.mode === 'name') viewer?.highlight(question.structureId, true, true, 42, true);
  else viewer?.highlight(null, false);
  renderQuiz();
}

function applyStep(step: DissectionStep): void {
  activeStep = step.id;
  const stage: ViewStage = step.id === 'mcf-view' ? 'inner' : 'bone';
  stageName = stage;
  viewer?.setBoneTransparent(false);
  viewer?.setViewContext(stage, step.id);
  viewer?.applyPreset(step);
  if (step.marker) {
    const mark = step.marker.review === '미검증' ? '미검증' : step.marker.review;
    viewer?.setMarker(step.marker.position_mm, `${text(step.marker.label)} · ${mark}`);
  } else {
    viewer?.setMarker(null, '');
  }
  selected = step.highlight ?? null;
  renderPeek();
  renderInfo();
  renderChips();
  renderPresets();
  void syncFloatPlanes();
}

function buildPresets(): void {
  sequenceRow.replaceChildren();
  activeSequence = presets?.sequences[0]?.id ?? '';
  for (const sequence of presets?.sequences ?? []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'text-btn';
    button.dataset.sequence = sequence.id;
    button.addEventListener('click', () => {
      activeSequence = sequence.id;
      activeStep = null;
      renderSequenceSteps();
      renderPresets();
    });
    sequenceRow.append(button);
  }
  renderSequenceSteps();
  renderPresets();
}

function renderSequenceSteps(): void {
  const sequence = presets?.sequences.find((item) => item.id === activeSequence);
  stepList.replaceChildren();
  sequence?.steps.forEach((step, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'step-btn';
    button.dataset.step = step.id;
    button.innerHTML = `<span class="step-num">${index + 1}</span><span data-step-title></span>`;
    button.addEventListener('click', () => applyStep(step));
    stepList.append(button);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(url);
  if (cached) return cached;
  const pending = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(url));
    image.src = url;
  });
  imageCache.set(url, pending);
  return pending;
}

function orientPoint(point: Vec3): void {
  if (!volume) return;
  crosshair = point;
  (['axial', 'coronal', 'sagittal'] as const).forEach((plane) => {
    const axis = volume!.planes[plane].axis;
    const count = volume!.dims[axis];
    planeState[plane].index = clampIndex(indexAlong(volume!, axis, point), count);
  });
  syncCrosshair();
  const slider = workspace.querySelector<HTMLInputElement>('#ct-index');
  if (slider) slider.value = String(planeState[activePlane].index);
  void drawCt();
  void syncFloatPlanes();
}

function displayPoint(orient: ReturnType<typeof ctDisplayOrient>, col01: number, row01: number, width: number, height: number): { x: number; y: number } {
  const mapped = mapRawToDisplay(orient, col01, row01);
  return { x: mapped.u * width, y: mapped.v * height };
}

async function drawCt(): Promise<void> {
  if (!volume) return;
  const plane = activePlane;
  const index = planeState[plane].index;
  const url = assetUrl(`${DATA}/${sliceFile(volume.planes[plane].folder, index, volume.index_digits, volume.file_extension)}`);
  const image = await loadImage(url);
  const rawCtx = rawCanvas.getContext('2d', { willReadFrequently: true });
  const ctx = ctCanvas.getContext('2d');
  if (!rawCtx || !ctx) return;
  if (rawCanvas.width !== image.naturalWidth || rawCanvas.height !== image.naturalHeight) {
    rawCanvas.width = image.naturalWidth;
    rawCanvas.height = image.naturalHeight;
  }
  rawCtx.drawImage(image, 0, 0);
  let raw = rawCache.get(url);
  if (!raw) {
    raw = rawCtx.getImageData(0, 0, rawCanvas.width, rawCanvas.height);
    rawCache.set(url, raw);
  }
  const windowWidth = Number(workspace.querySelector<HTMLInputElement>('#ct-window')?.value ?? 255);
  const level = Number(workspace.querySelector<HTMLInputElement>('#ct-level')?.value ?? 128);
  const out = rawCtx.createImageData(raw.width, raw.height);
  remapGray(raw.data, windowWidth, level, out.data);
  rawCtx.putImageData(out, 0, 0);
  const orient = ctDisplayOrient(plane);
  const size = displayedSize(orient, raw.width, raw.height);
  if (ctCanvas.width !== size.width || ctCanvas.height !== size.height) {
    ctCanvas.width = size.width;
    ctCanvas.height = size.height;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.save();
  ctx.translate(size.width / 2, size.height / 2);
  ctx.scale(orient.flipX ? -1 : 1, orient.flipY ? -1 : 1);
  ctx.rotate((orient.turnsCW * Math.PI) / 2);
  ctx.drawImage(rawCanvas, -raw.width / 2, -raw.height / 2);
  ctx.restore();
  if (contoursOn && viewer) {
    const pose = slicePose(volume, plane, index);
    const segments = contoursOnPlane(viewer.contourSources(true), pose.position, pose.normal);
    ctx.lineWidth = Math.max(1, image.naturalWidth / 220);
    for (const segment of segments) {
      const a = sliceFractions(volume, plane, index, segment.a);
      const b = sliceFractions(volume, plane, index, segment.b);
      const start = displayPoint(orient, a.col01, a.row01, size.width, size.height);
      const end = displayPoint(orient, b.col01, b.row01, size.width, size.height);
      ctx.strokeStyle = segment.color;
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    }
  }
  if (crosshair && ctPanelVisible(sheetSnap, desktopLayout())) {
    const frac = sliceFractions(volume, plane, index, crosshair);
    const at = displayPoint(orient, frac.col01, frac.row01, size.width, size.height);
    ctx.strokeStyle = '#8C2F1B';
    ctx.beginPath();
    ctx.moveTo(at.x, 0);
    ctx.lineTo(at.x, size.height);
    ctx.moveTo(0, at.y);
    ctx.lineTo(size.width, at.y);
    ctx.stroke();
  }
  const pose = slicePose(volume, plane, index);
  const axis = volume.planes[plane].axis;
  ctReadout.textContent = `${t(`ct.anatomical.${anatomicalPlaneName(plane)}`)} ${index + 1}/${volume.dims[axis]} · ${pose.position[axis].toFixed(1)} mm`;
  drawCtLabels(ctx, plane, index, orient);
}

async function syncFloatPlanes(): Promise<void> {
  if (!viewer || !volume) return;
  for (const plane of ['axial', 'coronal', 'sagittal'] as const) {
    const index = planeState[plane].index;
    const pose = slicePose(volume, plane, index);
    let image: HTMLImageElement | null = null;
    const visible = floatPlanes && plane === activePlane;
    if (visible) {
      const url = assetUrl(
        `${DATA}/${sliceFile(volume.planes[plane].folder, index, volume.index_digits, volume.file_extension)}`,
      );
      image = await loadImage(url);
    }
    viewer.setPlane({ id: plane, visible, opacity: 0.85, pose, image, flipY: volume.texture_flip_y });
  }
}

function buildCt(): void {
  if (!volume) return;
  ctPlanes.replaceChildren();
  (['axial', 'coronal', 'sagittal'] as const).forEach((plane) => {
    const count = volume!.dims[volume!.planes[plane].axis];
    const initial = volume!.planes[plane].initial_index;
    planeState[plane].index = clampIndex(initial ?? Math.floor((count - 1) / 2), count);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'text-btn';
    button.dataset.ctPlane = plane;
    button.textContent = t(`ct.anatomical.${anatomicalPlaneName(plane)}`);
    button.addEventListener('click', () => {
      activePlane = plane;
      const slider = workspace.querySelector<HTMLInputElement>('#ct-index')!;
      const axisCount = volume!.dims[volume!.planes[plane].axis];
      slider.max = String(Math.max(0, axisCount - 1));
      slider.value = String(planeState[plane].index);
      ctPlanes.querySelectorAll('button').forEach((item) => item.classList.toggle('is-active', item === button));
      renderOrient();
      void drawCt();
      void syncFloatPlanes();
    });
    ctPlanes.append(button);
  });
  const first = ctPlanes.querySelector('button');
  first?.classList.add('is-active');
  const slider = workspace.querySelector<HTMLInputElement>('#ct-index')!;
  const axisCount = volume.dims[volume.planes.axial.axis];
  slider.max = String(Math.max(0, axisCount - 1));
  slider.value = String(planeState.axial.index);
  slider.addEventListener('input', () => {
    if (!volume) return;
    planeState[activePlane].index = Number(slider.value);
    const base = crosshair ?? slicePose(volume, activePlane, planeState[activePlane].index).position;
    orientPoint(movePointToSlice(volume, activePlane, planeState[activePlane].index, base));
  });
  workspace.querySelector('#ct-window')?.addEventListener('input', () => void drawCt());
  workspace.querySelector('#ct-level')?.addEventListener('input', () => void drawCt());
  workspace.querySelector<HTMLInputElement>('#ct-contour')?.addEventListener('change', (event) => {
    contoursOn = (event.target as HTMLInputElement).checked;
    void drawCt();
  });
  workspace.querySelector<HTMLInputElement>('#ct-float')?.addEventListener('change', (event) => {
    floatPlanes = (event.target as HTMLInputElement).checked;
    void syncFloatPlanes();
  });
  ctCanvas.addEventListener('pointerdown', (event) => {
    if (!volume) return;
    const rect = ctCanvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const displayU = (event.clientX - rect.left) / rect.width;
    const displayV = (event.clientY - rect.top) / rect.height;
    const raw = mapDisplayToRaw(ctDisplayOrient(activePlane), displayU, displayV);
    const point = pointOnSlice(volume, activePlane, planeState[activePlane].index, raw.u, raw.v);
    orientPoint(point);
  });
  renderOrient();
  void drawCt();
}

function onPick(hit: PickHit | null): void {
  if (hit && (hit.structureId === 'upper-body' || hit.structureId === 'skin' || hit.structureId === 'ear-hotspot' || hit.structureId === 'skull-layer')) {
    if (!eacMm) return;
    const distance = Math.hypot(hit.pointMm[0] - eacMm[0], hit.pointMm[1] - eacMm[1], hit.pointMm[2] - eacMm[2]);
    if (hit.structureId === 'ear-hotspot' || distance < 48) flyStage(stageName === 'body' ? 'ear' : 'bone');
    return;
  }
  if (mode === 'quiz' && quiz && !quiz.answered && quiz.question.mode === 'locate') {
    if (hit) answerQuiz(hit.structureId);
    return;
  }
  if (mode !== 'view') return;
  if (!hit) {
    selected = null;
    viewer?.select(null, false);
    renderPeek();
    renderInfo();
    renderChips();
    return;
  }
  orientPoint(hit.pointMm);
  selectStructure(hit.structureId, true);
}

workspace.querySelectorAll<HTMLButtonElement>('[data-labels]').forEach((button) => {
  button.addEventListener('click', () => {
    labelMode = (button.dataset.labels as LabelMode) || 'basic';
    viewer?.setLabelMode(labelMode);
    paintStatic();
  });
});

workspace.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
  button.addEventListener('click', () => {
    const next = button.dataset.mode as 'view' | 'measure' | 'quiz';
    if (next === 'quiz') {
      setMode('quiz');
      openSheet(true);
      return;
    }
    setMode(next);
  });
});

workspace.querySelector('#measure-clear')?.addEventListener('click', () => {
  viewer?.clearMeasurement();
  renderMeasure([]);
});
workspace.querySelector('#quiz-name')?.addEventListener('click', () => startQuiz('name'));
workspace.querySelector('#quiz-locate')?.addEventListener('click', () => startQuiz('locate'));
workspace.querySelector('#quiz-exit')?.addEventListener('click', () => setMode('view'));
workspace.querySelector('#frame-btn')?.addEventListener('click', () => {
  viewer?.frameDefault();
  selected = null;
  activeStep = null;
  crosshair = null;
  viewer?.setCrosshair(null);
  flyStage('body');
  renderPeek();
  renderInfo();
  renderChips();
  renderPresets();
  void drawCt();
});
styleBtn.addEventListener('click', () => {
  renderStyle = renderStyle === 'atlas' ? 'model' : 'atlas';
  viewer?.setRenderStyle(renderStyle);
  paintStatic();
});

boneBtn.addEventListener('click', () => {
  viewer?.setBoneTransparent(!viewer.boneIsTransparent());
  boneBtn.textContent = viewer?.boneIsTransparent() ? t('bone.solid') : t('bone.transparent');
  boneBtn.setAttribute('aria-label', boneBtn.textContent ?? '');
  boneBtn.setAttribute('aria-pressed', String(viewer?.boneIsTransparent() === true));
});
let sheetDrag: { y: number; snap: SheetSnap; pointer: number } | null = null;
sheetToggle.style.touchAction = 'none';
sheetToggle.addEventListener('pointerdown', (event) => {
  if (desktopLayout()) return;
  event.preventDefault();
  sheetDrag = { y: event.clientY, snap: sheetSnap, pointer: event.pointerId };
  sheetToggle.setPointerCapture(event.pointerId);
});
sheetToggle.addEventListener(
  'touchmove',
  (event) => {
    if (!sheetDrag) return;
    event.preventDefault();
  },
  { passive: false },
);
sheetToggle.addEventListener('pointermove', (event) => {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointer || desktopLayout()) return;
  const next = Math.max(72, sheetCoverPx(sheetDrag.snap, window.innerHeight) - (event.clientY - sheetDrag.y));
  document.documentElement.style.setProperty('--sheet-cover', `${next}px`);
  syncLabelInset();
});
sheetToggle.addEventListener('pointerup', (event) => {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointer) return;
  const delta = event.clientY - sheetDrag.y;
  const start = sheetDrag.snap;
  sheetDrag = null;
  if (desktopLayout()) return;
  if (Math.abs(delta) < 10) applySnap(nextSnap(start));
  else applySnap(snapAfterDrag(start, delta, window.innerHeight));
});
sheetToggle.addEventListener('pointercancel', () => {
  sheetDrag = null;
  applySnap(sheetSnap);
});
searchInput.addEventListener('input', () => renderChips());

onLangChange(() => {
  if (quiz && !quiz.finished && manifest) {
    const question = quiz.question;
    if (question.mode === 'locate') {
      const structure = structureById(question.structureId);
      if (structure) question.label = text(structure.name);
    } else {
      question.choices = question.choices.map((choice) => {
        const structure = structureById(choice.id);
        return { id: choice.id, label: structure ? text(structure.name) : choice.label };
      });
    }
  }
  const step = activeStep ? findStep(activeStep) : undefined;
  if (step?.marker) viewer?.setMarker(step.marker.position_mm, `${text(step.marker.label)} · ${step.marker.review}`);
  paintStatic();
});

function drawCtLabels(
  ctx: CanvasRenderingContext2D,
  plane: SliceName,
  index: number,
  orient: ReturnType<typeof ctDisplayOrient>,
): void {
  ctx.save();
  ctx.font = '12px sans-serif';
  ctx.textBaseline = 'top';
  const nearby = ctLabels
    .filter(
      (label) =>
        label.plane === plane &&
        Math.abs(label.slice_index - index) <= 10 &&
        label.xy[0] > 0.02 &&
        label.xy[0] < 0.98 &&
        label.xy[1] > 0.02 &&
        label.xy[1] < 0.98,
    )
    .sort((a, b) => Math.abs(a.slice_index - index) - Math.abs(b.slice_index - index))
    .slice(0, 8);
  for (const label of nearby) {
    const at = displayPoint(orient, label.xy[0], label.xy[1], ctCanvas.width, ctCanvas.height);
    const x = at.x;
    const y = at.y;
    const caption = englishFirst(label.en, label.ko);
    const width = Math.min(ctx.measureText(caption).width + 8, ctCanvas.width - 8);
    ctx.fillStyle = 'rgba(247,245,240,0.88)';
    ctx.fillRect(x + 6, y - 2, width, 16);
    ctx.fillStyle = '#222';
    ctx.fillText(caption, x + 10, y, width - 8);
  }
  ctx.restore();
}

function renderCrumbs(): void {
  const crumbs = workspace.querySelector<HTMLElement>('#crumbs');
  if (!crumbs) return;
  const steps: { id: ViewStage; key: string }[] = [
    { id: 'body', key: 'crumbs.body' },
    { id: 'ear', key: 'crumbs.ear' },
    { id: 'bone', key: 'crumbs.bone' },
    { id: 'inner', key: 'crumbs.inner' },
  ];
  crumbs.replaceChildren();
  steps.forEach((step, index) => {
    if (index) {
      const sep = document.createElement('span');
      sep.textContent = ' / ';
      crumbs.append(sep);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = t(step.key);
    button.classList.toggle('is-active', stageName.startsWith(step.id));
    button.addEventListener('click', () => flyStage(step.id));
    crumbs.append(button);
  });
}

function stageBox(stage: ViewStage): { min: [number, number, number]; max: [number, number, number] } | null {
  if (!viewer) return null;
  if (stage === 'body') return viewer.entryBounds();
  if (stage === 'ear' && eacMm) {
    const pad = 46;
    return {
      min: [eacMm[0] - pad, eacMm[1] - pad * 1.15, eacMm[2] - 16],
      max: [eacMm[0] + pad * 0.8, eacMm[1] + pad * 0.85, eacMm[2] + 36],
    };
  }
  if (stage === 'bone') return viewer.boundsOf(['bone', 'sinus-dura']);
  return viewer.boundsOf([
    'scala-vestibuli',
    'scala-tympani',
    'vestibule',
    'scc-lateral',
    'scc-superior',
    'scc-posterior',
    'common-crus',
    'facial-nerve',
    'cochleovestibular-nerve',
  ]);
}

function flyStage(stage: ViewStage): void {
  if (!viewer || !manifest) return;
  activeStep = null;
  stageName = stage;
  viewer.clearPreset();
  viewer.setMarker(null, '');
  viewer.setViewContext(stage, null);
  viewer.setBoneTransparent(stage === 'inner');
  viewer.setShellOpen(stage === 'bone' || stage === 'inner');
  viewer.setStageHidden(hiddenForStage(stage, manifest.structures.map((item) => item.id)));
  viewer.setCutaway(0, 1);
  const box = stageBox(stage);
  const view = STAGE_VIEW[stage];
  if (box) {
    const pose = frameAabb({
      box,
      direction: view.direction,
      up: view.up,
      fovDeg: view.fov,
      viewWidthPx: Math.max(canvas.clientWidth, 1),
      viewHeightPx: Math.max(canvas.clientHeight, 1),
      margin: view.margin,
    });
    viewer.flyTo(pose.position, pose.target, view.up, view.fov);
  }
  boneBtn.textContent = viewer.boneIsTransparent() ? t('bone.solid') : t('bone.transparent');
  boneBtn.setAttribute('aria-label', boneBtn.textContent);
  boneBtn.setAttribute('aria-pressed', String(viewer.boneIsTransparent()));
  renderCrumbs();
  renderPresets();
  syncLabelInset();
}

function refitForSheet(): void {
  if (!viewer || !manifest || desktopLayout()) return;
  const width = Math.max(canvas.clientWidth, 1);
  const height = Math.max(canvas.clientHeight, 1);
  if (activeStep) {
    const step = findStep(activeStep);
    if (step) viewer.applyPreset(step);
    return;
  }
  const stage = (['body', 'ear', 'bone', 'inner'] as const).find((id) => stageName === id);
  if (!stage) return;
  const box = stageBox(stage);
  const view = STAGE_VIEW[stage];
  if (!box) return;
  const pose = frameAabb({
    box,
    direction: view.direction,
    up: view.up,
    fovDeg: view.fov,
    viewWidthPx: width,
    viewHeightPx: height,
    margin: view.margin,
  });
  viewer.flyTo(pose.position, pose.target, view.up, view.fov);
}

function applyStage(distance: number): void {
  document.body.dataset.distance = distance.toFixed(0);
  if (activeStep) return;
}

function refreshStudyLabels(): void {
  if (!viewer || !manifest) return;
  const parents = new Set(manifest.structures.map((item) => item.parent).filter((id): id is string => Boolean(id)));
  const labels: StudyLabel[] = [];
  const regionOf: Record<string, { id: string; en: string; ko: string }> = {
    ossicles: { id: 'region-ossicles', en: 'Ossicles', ko: '이소골' },
    'inner-ear': { id: 'region-inner', en: 'Inner ear', ko: '내이' },
    nerve: { id: 'region-nerve', en: 'Nerves', ko: '신경' },
    membrane: { id: 'region-middle', en: 'Middle ear', ko: '중이' },
    canal: { id: 'region-middle', en: 'Middle ear', ko: '중이' },
  };
  const buckets = new Map<string, [number, number, number][]>();
  const walls: Record<string, [number, number, number]> = {};
  for (const landmark of landmarks) {
    if (Object.values(CANAL_WALL).includes(landmark.id)) walls[landmark.id] = landmark.xyz_mm;
  }
  for (const structure of manifest.structures) {
    const center = viewer.structureCenter(structure.id);
    if (!center) continue;
    const region = regionOf[structure.layer];
    if (region) {
      const list = buckets.get(region.id) ?? [];
      list.push(center);
      buckets.set(region.id, list);
    }
    const english = displayEnglish(structure.name.en);
    const modes: LabelMode[] = ['basic', 'all'];
    if (SURGICAL_STRUCTURES.has(structure.id)) modes.push('surgical');
    const position = CANAL_WALL[structure.id]
      ? (walls[CANAL_WALL[structure.id]!] ?? center)
      : viewer.surfaceLabelAnchor(structure.id, center);
    const corePriority: Record<string, number> = {
      vestibule: 90,
      'scc-lateral': 86,
      'scc-superior': 82,
      'scc-posterior': 78,
      'facial-nerve': 70,
    };
    labels.push({
      id: structure.id,
      text: english,
      en: english,
      ko: structure.name.ko,
      tier: structure.parent || parents.has(structure.id) ? (structure.parent ? 'subpart' : 'structure') : 'structure',
      modes,
      priority: corePriority[structure.id] ?? (structure.parent ? 25 : structure.id === 'bone' ? 80 : 48),
      parentId: structure.parent,
      position,
      stages: structureStages(structure.id, structure.layer),
      steps: stepsForLabel(structure.id),
    });
  }
  const cochleaParts = ['scala-vestibuli', 'scala-tympani', 'scala-vestibuli-basal', 'scala-tympani-basal']
    .map((id) => viewer!.structureCenter(id))
    .filter((point): point is [number, number, number] => point !== null);
  if (cochleaParts.length) {
    const position: [number, number, number] = [0, 0, 0];
    for (const point of cochleaParts) {
      position[0] += point[0];
      position[1] += point[1];
      position[2] += point[2];
    }
    position[0] /= cochleaParts.length;
    position[1] /= cochleaParts.length;
    position[2] /= cochleaParts.length;
    labels.push({
      id: 'cochlea',
      text: 'Cochlea',
      en: 'Cochlea',
      ko: '와우',
      tier: 'structure',
      modes: ['basic', 'all'],
      priority: 92,
      position,
      stages: ['inner'],
    });
  }
  for (const [layer, region] of Object.entries(regionOf)) {
    void layer;
    const points = buckets.get(region.id);
    if (!points || labels.some((item) => item.id === region.id)) continue;
    const position: [number, number, number] = [0, 0, 0];
    for (const point of points) {
      position[0] += point[0];
      position[1] += point[1];
      position[2] += point[2];
    }
    position[0] /= points.length;
    position[1] /= points.length;
    position[2] /= points.length;
    labels.push({
      id: region.id,
      text: region.en,
      en: region.en,
      ko: region.ko,
      tier: 'region',
      modes: ['basic', 'all'],
      priority: 30,
      position,
      stages: ['bone'],
    });
  }
  for (const item of landmarks) {
    const english = displayEnglish(item.en);
    const steps = stepsForLabel(item.id);
    const placed = item.confidence === 'placed' || steps.length > 0;
    const core = item.id === 'iac';
    labels.push({
      id: item.id,
      text: english,
      en: english,
      ko: item.ko,
      tier: core ? 'structure' : 'subpart',
      modes: core ? ['basic', 'surgical', 'all'] : placed ? ['surgical', 'all'] : ['all'],
      priority: core ? 90 : (item.surgical ? 72 : 58) + (steps.length ? 8 : 0),
      parentId: item.parent,
      position: item.xyz_mm,
      stages: stagesForLandmark(item.id),
      steps,
    });
  }
  for (const item of surfaceLabels) {
    const english = displayEnglish(item.en);
    labels.push({
      id: item.id,
      text: english,
      en: english,
      ko: item.ko,
      tier: 'surface',
      modes: ['basic', 'all'],
      priority: ['helix', 'tragus', 'lobule'].includes(item.id) ? 80 : 28,
      position: item.xyz_mm,
      stages: ['body', 'ear'],
    });
  }
  viewer.setStudyLabels(dedupeStudyLabels(labels));
}

function registrationTable(): string {
  if (!registration) return '';
  const rows = registration.current.pairs
    .map(
      (pair) =>
        `<tr><td>${escapeHtml(englishFirst(pair.en, pair.ko))}</td><td>${pair.residualMm.toFixed(1)}</td></tr>`,
    )
    .join('');
  const without = registration.umeyamaWithoutMastoid
    ? ` · without mastoid ${registration.umeyamaWithoutMastoid.scale.toFixed(2)} / ${registration.umeyamaWithoutMastoid.rmsMm.toFixed(1)} mm`
    : '';
  return `
    <h3>${escapeHtml(t('dev.registration'))}</h3>
    <p class="hint">${escapeHtml(registration.scaleDecision)}</p>
    <p class="source-line">${escapeHtml(registration.review)} · RMS ${registration.current.rmsMm.toFixed(1)} mm · Umeyama ${registration.umeyama.scale.toFixed(2)} / ${registration.umeyama.rmsMm.toFixed(1)} mm${escapeHtml(without)}</p>
    <table class="reg-table"><tbody>${rows}</tbody></table>
  `;
}

function renderDev(): void {
  devCard.hidden = !DEV || !manifest;
  if (!DEV || !manifest) return;
  const offset = manifest.viewer_offset_mm.map((value) => value.toFixed(2)).join(', ');
  const options = landmarks
    .map((item) => `<option value="${escapeHtml(item.id)}"${item.id === devLandmark ? ' selected' : ''}>${escapeHtml(englishFirst(item.en, item.ko))}</option>`)
    .join('');
  devBody.innerHTML = `
    <p class="source-line">${escapeHtml(t('common.version'))} ${escapeHtml(manifest.model_version)}</p>
    <p class="source-line">viewer_offset_mm ${escapeHtml(offset)}</p>
    <p class="source-line">${escapeHtml(text(manifest.coordinate_system.note))}</p>
    <p class="hint">${escapeHtml(t('dev.pick'))}</p>
    <select id="dev-landmark">${options}</select>
    <pre class="source-line" id="dev-log"></pre>
    <button type="button" class="text-btn" id="dev-export">${escapeHtml(t('dev.export'))}</button>
    ${registrationTable()}
  `;
  devBody.querySelector<HTMLSelectElement>('#dev-landmark')?.addEventListener('change', (event) => {
    devLandmark = (event.target as HTMLSelectElement).value;
  });
  devBody.querySelector('#dev-export')?.addEventListener('click', () => {
    const blob = new Blob(
      [JSON.stringify({ model_version: manifest?.model_version, review: '미검증', landmarks }, null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'landmarks.json';
    link.click();
    URL.revokeObjectURL(url);
  });
}

async function boot(): Promise<void> {
  paintStatic();
  setMode('view');
  const loaded = await fetchJson<Manifest>(publicUrl(`${DATA}/manifest.json`));
  const manifestIssues = validateManifest(loaded);
  if (manifestIssues.length) throw new Error(formatIssues(manifestIssues));
  manifest = loaded;
  const knownIds = new Set(loaded.structures.map((item) => item.id));
  const contentPairs = await Promise.all(
    loaded.structures.map(async (structure) => {
      const data = await fetchJson<unknown>(publicUrl(`${DATA}/${structure.content}`));
      const issues = validateContent(data, structure.id, knownIds);
      if (issues.length) throw new Error(`${structure.id}\n${formatIssues(issues)}`);
      return [structure.id, data as StructureContent] as const;
    }),
  );
  contents = new Map(contentPairs);
  presets = await fetchJson<PresetFile>(publicUrl(`${DATA}/presets.json`));
  const presetIssues = validatePresets(presets, knownIds);
  if (presetIssues.length) throw new Error(formatIssues(presetIssues));
  volume = await fetchJson<VolumeMeta>(publicUrl(`${DATA}/ct/volume.json`));
  const volumeIssues = validateVolume(volume);
  if (volumeIssues.length) throw new Error(formatIssues(volumeIssues));

  const [landmarkFile, surfaceFile, ctFile, registrationFile, termFile] = await Promise.all([
    fetchJson<{ landmarks: XyzItem[] }>(publicUrl(`${DATA}/landmarks.json`)),
    fetchJson<{ labels: XyzItem[] }>(publicUrl(`${DATA}/surface-anatomy.json`)),
    fetchJson<{ labels: CtAnnotation[] }>(publicUrl(`${DATA}/ct-labels.json`)),
    fetchJson<RegistrationFile>(publicUrl('models/upper-body/registration.json')).catch(() => null),
    fetchJson<{ terms: TermRecord[] }>(publicUrl('shared/terms.json')).catch(() => ({ terms: [] as TermRecord[] })),
  ]);
  registration = registrationFile;
  landmarks = landmarkFile.landmarks;
  surfaceLabels = surfaceFile.labels;
  ctLabels = ctFile.labels;
  searchIndex = buildSearchIndex(
    loaded.structures.map((structure) => ({
      id: structure.id,
      en: structure.name.en,
      ko: structure.name.ko,
      parentId: structure.parent,
    })),
    landmarks.map((item) => ({ id: item.id, en: item.en, ko: item.ko, parentId: item.parent })),
    termFile.terms ?? [],
  );
  searchIndex.push({
    id: 'cochlea',
    kind: 'structure',
    en: 'Cochlea',
    ko: '와우',
    aliases: ['scala vestibuli', 'scala tympani', '전정계', '고실계'],
  });
  eacMm = landmarks.find((item) => item.id === 'eac-porus')?.xyz_mm ?? null;

  viewer = new EntViewer(canvas, manifest.viewer_offset_mm);
  if (renderStyle === 'model') viewer.setRenderStyle('model');
  viewer.setScaleElement(workspace.querySelector('#scale-hud'));
  viewer.onPick(onPick);
  viewer.onMeasure((points) => renderMeasure(points));
  viewer.onFrame((distance) => applyStage(distance));
  viewer.onShiftPoint((point) => {
    if (!DEV) return;
    const log = devBody.querySelector<HTMLElement>('#dev-log');
    if (log) log.textContent = point.map((value) => value.toFixed(2)).join(', ');
    const item = landmarks.find((landmark) => landmark.id === devLandmark);
    if (item) {
      item.xyz_mm = [point[0], point[1], point[2]];
      refreshStudyLabels();
    }
  });
  viewer.onLabel((id) => {
    openSheet(true);
    if (mode === 'quiz') return;
    if (structureById(id)) {
      viewer?.flash(id);
      selectStructure(id, true);
      return;
    }
    const point = landmarks.find((item) => item.id === id);
    if (point?.parent && structureById(point.parent)) selectStructure(point.parent, true);
  });

  const parents = new Set(manifest.structures.map((item) => item.parent).filter((id): id is string => Boolean(id)));
  const failures: string[] = [];
  await Promise.all(
    manifest.structures.map(async (structure) => {
      const layer = manifest!.layers.find((item) => item.id === structure.layer);
      try {
        await viewer!.loadStructure(
          structure.id,
          assetUrl(`${DATA}/${structure.file}`),
          structure.color,
          structure.layer,
          layer?.opacity ?? 1,
          structureLabel(structure.id),
          { parentId: structure.parent, aggregate: parents.has(structure.id) },
        );
      } catch {
        failures.push(structure.id);
      }
    }),
  );
  if (eacMm) {
    try {
      await viewer.loadUpperBody(
        {
          skull: assetUrl('models/upper-body/skull.glb'),
          auricle: assetUrl('models/upper-body/auricle.glb'),
          skin: assetUrl('models/upper-body/skin.glb'),
        },
        eacMm,
      );
    } catch {
      failures.push('upper-body');
    }
  }
  refreshStudyLabels();
  viewer.setLabelMode(labelMode);
  if (DEV && registration && !registrationShown) {
    registrationShown = true;
    viewer.setRegistrationOverlay(registration.current.pairs);
  }
  if (DEV || SHOT) {
    const hook = {
      fly(position: [number, number, number], target: [number, number, number]) {
        viewer?.flyTo(position, target);
      },
      style(next: 'atlas' | 'model') {
        renderStyle = next;
        viewer?.setRenderStyle(next);
        paintStatic();
      },
      select(id: string, frame = true) {
        selectStructure(id, frame);
      },
      distance: () => viewer?.cameraDistance() ?? 0,
      pose: () => viewer?.cameraPose() ?? null,
      crosshair: () => viewer?.crosshairVisible() ?? false,
      shellHidden: () => viewer?.shellHidden() ?? false,
      eac: () => eacMm,
      labels(mode: 'basic' | 'surgical' | 'all') {
        labelMode = mode;
        viewer?.setLabelMode(mode);
      },
    };
    (window as unknown as { __ent?: typeof hook }).__ent = hook;
  }

  buildPresets();
  buildCt();
  viewer.start();
  if (eacMm) flyStage('body');
  stageStatus.hidden = failures.length === 0;
  if (failures.length) stageStatus.textContent = `${t('temporal.loadError')} ${failures.join(', ')}`;
  paintStatic();
}

applySnap('peek');
window.addEventListener('resize', () => {
  applySnap(desktopLayout() ? sheetSnap : sheetSnap);
  syncLabelInset();
});
const blockPinch = (event: Event) => event.preventDefault();
document.addEventListener('gesturestart', blockPinch, { passive: false });
document.addEventListener('gesturechange', blockPinch, { passive: false });
workspace.querySelector('.stage')?.addEventListener(
  'touchmove',
  (event) => {
    const touch = event as TouchEvent;
    if (touch.touches.length > 1) touch.preventDefault();
  },
  { passive: false },
);

boot().catch((error: unknown) => {
  stageStatus.hidden = false;
  const message = error instanceof Error ? error.message : String(error);
  stageStatus.textContent = `${t('temporal.loadError')}\n${message}`;
});
