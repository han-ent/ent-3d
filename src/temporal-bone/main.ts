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
  placeAlong,
  structureStages,
  SURGICAL_STRUCTURES,
  type ViewStage,
} from '../shared/stage-frame';
import { isNavShell, shouldStageJump } from '../shared/picking';
import { COCHLEA_PARTS, STAGE_LIMITS, groupPickId, labelAction, listSelectionId, visibleFovDeg } from '../shared/zoom-fit';
import { CANAL_WALL } from '../shared/surface-anchor';
import { contoursOnPlane, indexAlong, movePointToSlice, pointOnSlice, remapGray, sliceFractions, type ContourSegment, type SliceName } from '../shared/ct-slice';
import { sliceFile, slicePose, clampIndex } from '../shared/ct';
import { WINDOW_PRESETS, consumeDragSteps, containedRect, dragWindowLevel, formatSliceOverlay, formatWindowOverlay, scrollIndex } from '../shared/pacs';
import { firstLine, isPendingText, paragraphLines, sentenceNeedsSourceCheck } from '../shared/content-display';
import { installFonts } from '../shared/fonts';
import { applyI18n, getLang, initI18n, onLangChange, t, text } from '../shared/i18n';
import { distanceMm, formatDistanceMm } from '../shared/measurement';
import { assetUrl, fetchJson, pageUrl, publicUrl } from '../shared/paths';
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
    <div class="view-slot" id="view-slot">
      <canvas id="view"></canvas>
    </div>
    <div id="pacs" class="pacs" hidden>
      <section class="pacs-pane" data-plane="coronal" data-anatomical="axial">
        <canvas class="pacs-canvas"></canvas>
        <p class="pacs-name"></p>
        <p class="pacs-im"></p>
        <p class="pacs-wl"></p>
        <span class="pacs-mark left"></span>
        <span class="pacs-mark top"></span>
        <span class="pacs-mark right"></span>
        <span class="pacs-mark bottom"></span>
        <input class="pacs-slider" type="range" min="0" max="1" value="0" data-i18n-aria="ct.slice" />
      </section>
      <section class="pacs-pane" data-plane="sagittal" data-anatomical="coronal">
        <canvas class="pacs-canvas"></canvas>
        <p class="pacs-name"></p>
        <p class="pacs-im"></p>
        <p class="pacs-wl"></p>
        <span class="pacs-mark left"></span>
        <span class="pacs-mark top"></span>
        <span class="pacs-mark right"></span>
        <span class="pacs-mark bottom"></span>
        <input class="pacs-slider" type="range" min="0" max="1" value="0" data-i18n-aria="ct.slice" />
      </section>
      <section class="pacs-pane" data-plane="axial" data-anatomical="sagittal">
        <canvas class="pacs-canvas"></canvas>
        <p class="pacs-name"></p>
        <p class="pacs-im"></p>
        <p class="pacs-wl"></p>
        <span class="pacs-mark left"></span>
        <span class="pacs-mark top"></span>
        <span class="pacs-mark right"></span>
        <span class="pacs-mark bottom"></span>
        <input class="pacs-slider" type="range" min="0" max="1" value="0" data-i18n-aria="ct.slice" />
      </section>
      <div class="pacs-bar">
        <div class="pacs-planes" id="pacs-planes"></div>
        <button type="button" id="pacs-tool" data-i18n="ct.tool.scroll"></button>
        <input id="pacs-index" type="range" min="0" max="1" value="0" data-i18n-aria="ct.slice" />
        <button type="button" id="pacs-close" data-i18n="ct.pacsClose"></button>
      </div>
    </div>
    <div class="stage-status" id="stage-status" data-i18n="temporal.loading"></div>
    <div class="scale-hud" id="scale-hud">
      <span class="scale-bar-line" data-scale-line></span>
      <span data-scale-label>10 mm</span>
    </div>
    <div class="labelbar" id="labelbar" role="toolbar">
      <button type="button" data-labels="basic" data-i18n="labels.basic"></button>
      <button type="button" data-labels="surgical" data-i18n="labels.surgical"></button>
      <button type="button" data-labels="all" data-i18n="labels.all"></button>
      <button type="button" id="help-btn" data-i18n="menu.help"></button>
    </div>
    <div class="crumbs" id="crumbs"></div>
    <div class="measure-card" id="measure-readout" hidden>
      <div id="measure-text"></div>
      <button type="button" id="measure-clear" data-i18n="measure.clear"></button>
    </div>
    <p class="stage-caption" id="stage-caption"></p>
    <button type="button" id="back-chip" class="back-chip phone-only" hidden></button>
    <div id="pick-chip" class="pick-chip" hidden></div>
    <div class="phone-dock phone-only" id="phone-dock">
      <div class="stage-seg" id="stage-seg" role="tablist"></div>
      <div class="fab-col">
        <button type="button" class="fab" id="fit-btn">↺</button>
        <button type="button" class="fab" id="bone-fab"></button>
        <button type="button" class="fab" id="label-fab">Aa</button>
      </div>
    </div>
    <div id="label-pop" class="pop-menu phone-only" hidden></div>
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
    <div class="sheet-head" id="sheet-head">
    <button type="button" class="sheet-handle" id="sheet-toggle" aria-expanded="false">
      <span class="grip"></span>
      <span class="sr-only" data-i18n="sheet.expand"></span>
    </button>
    <div class="phone-peek phone-only" id="phone-peek">
      <h2 id="phone-stage"></h2>
      <div class="section-row">
        <button type="button" data-section="presets" data-i18n="presets.title"></button>
        <button type="button" data-section="ct" data-i18n="ct.title"></button>
        <button type="button" data-section="list" data-i18n="sheet.list"></button>
      </div>
    </div>
    <div class="peek">
      <h2 id="peek-title"></h2>
      <p id="peek-line"></p>
      <div class="peek-actions" id="peek-actions"></div>
    </div>
    </div>
    <div class="sheet-body" id="sheet-body">
      <div class="sheet-tabs" id="sheet-tabs">
        <button type="button" data-tab="structures" data-i18n="sheet.tab.structures"></button>
        <button type="button" data-tab="ct" data-i18n="sheet.tab.ct"></button>
        <button type="button" data-tab="info" data-i18n="sheet.tab.info"></button>
      </div>
      <p class="review-line" data-i18n="sheet.reviewLine"></p>
      <div id="info-body"></div>
      <section id="list-section">
        <h3 data-i18n="sheet.structures"></h3>
        <input class="struct-search" id="structure-search" type="search" data-i18n-aria="sheet.search" />
        <div id="structure-list"></div>
      </section>
      <section id="presets-section">
        <h3 data-i18n="presets.title"></h3>
        <p class="hint" data-i18n="presets.note"></p>
        <div class="btn-row" id="sequence-row"></div>
        <div id="step-list"></div>
        <div id="step-detail"></div>
      </section>
      <section id="ct-section">
        <h3 data-i18n="ct.title"></h3>
        <p class="hint" data-i18n="ct.hint"></p>
        <div class="btn-row" id="ct-planes"></div>
        <div class="btn-row">
          <button type="button" class="text-btn" id="ct-preset-bone" data-i18n="ct.preset.bone"></button>
          <button type="button" class="text-btn" id="ct-preset-soft" data-i18n="ct.preset.soft"></button>
          <button type="button" class="text-btn" id="ct-open" data-i18n="ct.pacsOpen"></button>
        </div>
        <div class="ct-orient" id="ct-orient-top"></div>
        <canvas class="ct-canvas" id="ct-canvas"></canvas>
        <div class="ct-orient" id="ct-orient-bottom"></div>
        <p class="meta" id="ct-readout"></p>
        <label class="checkline"><span data-i18n="ct.window"></span><input id="ct-window" type="range" min="20" max="400" value="255" /></label>
        <label class="checkline"><span data-i18n="ct.level"></span><input id="ct-level" type="range" min="0" max="255" value="128" /></label>
        <input id="ct-index" type="range" min="0" max="1" value="0" data-i18n-aria="ct.slice" />
        <label class="checkline"><input id="ct-contour" type="checkbox" checked /><span data-i18n="ct.contour"></span></label>
        <label class="checkline"><input id="ct-float" type="checkbox" /><span data-i18n="ct.overlay"></span></label>
        <p class="ct-credit" id="ct-credit" data-i18n="ct.credit"></p>
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
  <div id="safe-probe" aria-hidden="true"></div>
  <div id="gesture-guide" class="gesture-guide" hidden>
    <div class="gesture-card" role="dialog" aria-modal="true">
      <h2 data-i18n="guide.title"></h2>
      <ul>
        <li data-i18n="guide.rotate"></li>
        <li data-i18n="guide.pinch"></li>
        <li data-i18n="guide.tap"></li>
        <li data-i18n="guide.double"></li>
      </ul>
      <button type="button" id="guide-dismiss" data-i18n="guide.dismiss"></button>
    </div>
  </div>
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
let selectionTitle: { ko: string; en: string } | null = null;
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
let pacsOpen = false;
let pacsTool: 'scroll' | 'window' = 'scroll';
let windowWidth = 255;
let windowLevel = 128;
let pacsShow: SliceName | '3d' = 'coronal';
const imageCache = new Map<string, Promise<HTMLImageElement>>();
const rawCache = new Map<string, ImageData>();
const orientedScratch = new Map<SliceName, HTMLCanvasElement>();
const contourCache = new Map<string, ContourSegment[]>();
let rawLock: Promise<unknown> = Promise.resolve();
const pacsRoot = workspace.querySelector<HTMLElement>('#pacs')!;

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

function landscapePhone(): boolean {
  if (desktopLayout()) return false;
  return (
    window.matchMedia('(orientation: landscape) and (max-width: 959px)').matches ||
    window.matchMedia('(max-height: 500px) and (max-width: 959px)').matches
  );
}

function coarsePointer(): boolean {
  return window.matchMedia('(pointer: coarse)').matches;
}

function tabletLayout(): boolean {
  if (!coarsePointer() || landscapePhone()) return false;
  if (window.matchMedia('(max-width: 767px) and (orientation: portrait)').matches) return false;
  const shortSide = Math.min(window.innerWidth, window.innerHeight);
  const longSide = Math.max(window.innerWidth, window.innerHeight);
  return window.innerWidth >= 768 && shortSide >= 600 && longSide <= 1400;
}

function layoutKind(): 'desktop' | 'tablet' | 'side' | 'phone' {
  if (landscapePhone()) return 'phone';
  if (window.matchMedia('(max-width: 767px) and (orientation: portrait)').matches) return 'phone';
  if (tabletLayout()) return 'tablet';
  if (desktopLayout()) return 'desktop';
  return 'side';
}

function portraitPhone(): boolean {
  return layoutKind() === 'phone' && !landscapePhone();
}

function safeInset(edge: 'top' | 'bottom'): number {
  const probe = document.getElementById('safe-probe');
  if (!probe) return 0;
  const style = getComputedStyle(probe);
  return parseFloat(edge === 'top' ? style.paddingTop : style.paddingBottom) || 0;
}

function phoneVisible(): { x: number; y: number; width: number; height: number } | null {
  const kind = layoutKind();
  if (kind !== 'phone' && kind !== 'tablet') return null;
  const width = Math.max(canvas.clientWidth, window.innerWidth, 1);
  const height = Math.max(canvas.clientHeight, window.innerHeight, 1);
  const top = safeInset('top') + 64;
  if (landscapePhone() || kind === 'tablet') {
    const sheetW = kind === 'tablet' ? Math.round(Math.min(width * 0.32, 320)) : Math.round(Math.min(width * 0.23, 260));
    return {
      x: 8,
      y: top,
      width: Math.max(80, width - sheetW - 16),
      height: Math.max(80, height - top - 72),
    };
  }
  const bottom = sheetCoverPx(sheetSnap, window.innerHeight) + safeInset('bottom') + 62;
  return {
    x: 10,
    y: top,
    width: Math.max(80, width - 86),
    height: Math.max(80, height - top - bottom),
  };
}

function syncVisibleRect(): void {
  if (pacsOpen && layoutKind() === 'tablet') {
    viewer?.setVisibleRect(null);
    return;
  }
  viewer?.setVisibleRect(phoneVisible());
}

function applySnap(snap: SheetSnap): void {
  const phone = portraitPhone();
  const land = landscapePhone();
  if (phone) sheetSnap = snap;
  const cover = phone ? sheetCoverPx(sheetSnap, window.innerHeight) + safeInset('bottom') : 0;
  document.documentElement.style.setProperty('--sheet-cover', `${cover}px`);
  sheet.dataset.snap = phone ? sheetSnap : 'full';
  document.body.classList.toggle('is-sheet-full', phone && sheetSnap === 'full');
  document.body.classList.toggle('is-phone', phone || land);
  document.body.classList.toggle('is-landscape-phone', land);
  document.body.classList.toggle('is-tablet', layoutKind() === 'tablet');
  document.body.classList.toggle('is-tablet-portrait', layoutKind() === 'tablet' && window.innerHeight > window.innerWidth);
  document.body.classList.toggle('is-compact', layoutKind() !== 'desktop');
  const topbar = document.querySelector('.topbar');
  if (topbar) document.documentElement.style.setProperty('--topbar-h', `${Math.ceil(topbar.getBoundingClientRect().height)}px`);
  const open = land || !phone || sheetSnap !== 'peek';
  sheet.classList.toggle('is-open', open);
  sheetToggle.setAttribute('aria-expanded', String(open));
  sheetToggle.setAttribute('aria-label', open ? t('sheet.collapse') : t('sheet.expand'));
  syncCrosshair();
  syncVisibleRect();
  syncLabelInset();
}

function openSheet(open: boolean): void {
  applySnap(open ? (sheetSnap === 'peek' ? 'half' : sheetSnap) : 'peek');
}

function syncCrosshair(): void {
  const show = crosshair && (pacsOpen || ctPanelVisible(sheetSnap, layoutKind() !== 'phone')) ? crosshair : null;
  viewer?.setCrosshair(show);
  viewer?.setCursorScale(pacsOpen ? 4 : 1);
}

function syncPacsMarker(): void {
  if (!viewer) return;
  if (pacsOpen && crosshair) {
    viewer.setMarker(crosshair, '');
    viewer.setCursorScale(4);
    return;
  }
  viewer.setCursorScale(1);
  const step = activeStep ? findStep(activeStep) : undefined;
  if (step?.marker) viewer.setMarker(step.marker.position_mm, `${text(step.marker.label)} · ${step.marker.review}`);
  else viewer.setMarker(null, '');
}

function singlePlanePacs(): boolean {
  return layoutKind() === 'phone' || document.body.classList.contains('is-tablet-portrait');
}

function syncLabelInset(): void {
  if (!viewer) return;
  if (pacsOpen) {
    const slot = document.getElementById('view-slot');
    if (!slot) return;
    const slotRect = slot.getBoundingClientRect();
    if (slotRect.width < 2 || slotRect.height < 2) return;
    let top = 8;
    let right = 8;
    let bottom = 8;
    let left = 8;
    for (const node of workspace.querySelectorAll('.labelbar, .gizmo, .modebar, .crumbs, .scale-hud, .pacs-bar')) {
      const rect = node.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2 || getComputedStyle(node).visibility === 'hidden') continue;
      const overlapW = Math.min(rect.right, slotRect.right) - Math.max(rect.left, slotRect.left);
      const overlapH = Math.min(rect.bottom, slotRect.bottom) - Math.max(rect.top, slotRect.top);
      if (overlapW < 8 || overlapH < 8) continue;
      if (rect.top < slotRect.top + slotRect.height * 0.55) top = Math.max(top, rect.bottom - slotRect.top + 8);
      if (rect.bottom > slotRect.bottom - slotRect.height * 0.55) bottom = Math.max(bottom, slotRect.bottom - rect.top + 8);
      if (rect.left > slotRect.left + slotRect.width * 0.45) right = Math.max(right, slotRect.right - rect.left + 8);
    }
    viewer.setLabelInset({ top, right, bottom, left });
    return;
  }
  const kind = layoutKind();
  if (kind === 'tablet') {
    const width = Math.max(canvas.clientWidth, window.innerWidth, 1);
    const sheetW = Math.round(Math.min(width * 0.32, 320));
    viewer.setLabelInset({ top: safeInset('top') + 68, right: sheetW + 16, bottom: safeInset('bottom') + 24, left: 12 });
    return;
  }
  if (kind === 'phone') {
    const width = Math.max(canvas.clientWidth, window.innerWidth, 1);
    const height = Math.max(canvas.clientHeight, window.innerHeight, 1);
    const top = safeInset('top') + 68;
    if (landscapePhone()) {
      const sheetW = Math.round(Math.min(width * 0.23, 260));
      viewer.setLabelInset({ top, right: sheetW + 16, bottom: safeInset('bottom') + 76, left: 12 });
    } else {
      const bottom = sheetCoverPx(sheetSnap, window.innerHeight) + safeInset('bottom') + 70;
      viewer.setLabelInset({ top, right: 78, bottom, left: 12 });
    }
    return;
  }
  const stageEl = workspace.querySelector('.stage');
  if (!stageEl) return;
  const stageRect = stageEl.getBoundingClientRect();
  let freeTop = stageRect.top;
  let freeRight = stageRect.right;
  let freeBottom = stageRect.bottom;
  let freeLeft = stageRect.left;
    for (const node of workspace.querySelectorAll('.labelbar, .gizmo, .modebar, .crumbs, .scale-hud, .stage-caption, #sheet, .phone-dock, .back-chip, #structure-search')) {
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
  syncPhoneFabs();
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
  renderBackChip();
  renderPhoneMenu();
  refreshPlaneButtons();
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
    peekTitle.textContent = selectionTitle ? englishFirst(selectionTitle.en, selectionTitle.ko) : structureLabel(structure.id);
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
  if (layoutKind() === 'phone') {
    const ct = document.createElement('button');
    ct.type = 'button';
    ct.textContent = t('sheet.ctView');
    ct.addEventListener('click', () => viewSelectionOnCt());
    peekActions.append(ct);
  }
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
  const activeId = listSelectionId(selected, selectionTitle?.en ?? null);
  let cochleaRow = false;
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
      if (activeId === 'cochlea' && structure.id.startsWith('scala-') && !cochleaRow) {
        cochleaRow = true;
        const cochlea = document.createElement('button');
        cochlea.type = 'button';
        cochlea.className = 'chip is-active';
        cochlea.dataset.select = 'cochlea';
        cochlea.innerHTML = `<i class="swatch" style="background:${structure.color}"></i><span>${escapeHtml(englishFirst('Cochlea', '와우'))}</span>`;
        cochlea.addEventListener('click', () => {
          if (mode === 'quiz') return;
          setMode('view');
          focusCochlea();
        });
        const cochleaRowEl = document.createElement('div');
        cochleaRowEl.className = 'chip-row';
        cochleaRowEl.append(cochlea);
        structureList.append(cochleaRowEl);
      }
      if (structure.id === activeId) button.classList.add('is-active');
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
        if (hit.id === 'cochlea') {
          focusCochlea();
          return;
        }
        const parent = hit.parentId;
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
        if (hit.id === 'iac') {
          focusIac();
          return;
        }
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

function selectStructure(id: string, frame: boolean, title?: { ko: string; en: string } | null): void {
  selected = id;
  selectionTitle = title ?? null;
  const structure = structureById(id);
  if (structure) viewer?.setHidden(id, false);
  viewer?.flash(id);
  if (portraitPhone()) applySnap(frame && sheetSnap === 'full' ? 'half' : frame ? sheetSnap : 'peek');
  viewer?.select(id, frame);
  if (pacsOpen) {
    const center = viewer?.structureCenter(id);
    if (center) orientPoint(center);
  }
  const sheetBody = document.querySelector<HTMLElement>('#sheet-body');
  if (sheetBody) sheetBody.scrollTop = 0;
  renderPeek();
  renderInfo();
  renderChips();
  renderBackChip();
}

function lowerSheetAfterFit(): void {
  if (portraitPhone() && sheetSnap === 'full') applySnap('half');
}

function focusCochlea(): void {
  selectStructure('scala-vestibuli', false, { ko: '와우', en: 'Cochlea' });
  viewer?.frameIds(COCHLEA_PARTS);
  lowerSheetAfterFit();
}

function focusIac(): void {
  const point = landmarks.find((item) => item.id === 'iac')?.xyz_mm;
  selectStructure('cochleovestibular-nerve', false, { ko: '내이도', en: 'IAC' });
  if (point) viewer?.frameSphere(point, 8);
  lowerSheetAfterFit();
}

function viewSelectionOnCt(): void {
  if (!selected) return;
  const center = viewer?.structureCenter(selected);
  openSection('ct');
  setPacs(true);
  if (center) orientPoint(center);
}

function applySheetTab(tab: 'structures' | 'ct' | 'info'): void {
  document.body.dataset.sheetTab = tab;
  for (const button of workspace.querySelectorAll<HTMLButtonElement>('#sheet-tabs button')) {
    button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
  }
  if (layoutKind() !== 'desktop') setPacs(tab === 'ct');
}

const GUIDE_KEY = 'ent3d.guide';

function openGuide(): void {
  const guide = document.getElementById('gesture-guide');
  if (guide) guide.hidden = false;
}

function dismissGuide(): void {
  try {
    localStorage.setItem(GUIDE_KEY, '1');
  } catch {
    /* private mode */
  }
  const guide = document.getElementById('gesture-guide');
  if (guide) guide.hidden = true;
}

function maybeOpenGuide(): void {
  try {
    if (localStorage.getItem(GUIDE_KEY) === '1') return;
  } catch {
    return;
  }
  openGuide();
}

function openSection(id: 'presets' | 'ct' | 'list'): void {
  applySnap('full');
  applySheetTab(id === 'list' ? 'structures' : 'ct');
  const section = document.getElementById(`${id === 'list' ? 'list' : id}-section`);
  requestAnimationFrame(() => section?.scrollIntoView({ block: 'start' }));
}

function hidePicker(): void {
  const chip = workspace.querySelector<HTMLElement>('#pick-chip');
  if (chip) chip.hidden = true;
}

function groupedOverlaps(hit: PickHit): { key: string; structureId: string; point: Vec3 }[] {
  const items = hit.overlaps?.length ? hit.overlaps : [{ structureId: hit.structureId, pointMm: hit.pointMm }];
  const groups = new Map<string, { key: string; structureId: string; point: Vec3 }>();
  for (const item of items) {
    const key = groupPickId(item.structureId);
    if (!groups.has(key)) groups.set(key, { key, structureId: item.structureId, point: item.pointMm });
  }
  return [...groups.values()];
}

function pickLabel(key: string): string {
  if (key === 'cochlea') return getLang() === 'ko' ? '와우' : 'Cochlea';
  const structure = structureById(key);
  if (structure) return getLang() === 'ko' ? structure.name.ko : structure.name.en;
  return key;
}

function showPicker(choices: { key: string; structureId: string; point: Vec3 }[]): void {
  const chip = workspace.querySelector<HTMLElement>('#pick-chip');
  if (!chip) return;
  chip.replaceChildren();
  for (const choice of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = pickLabel(choice.key);
    button.addEventListener('click', () => {
      hidePicker();
      if (choice.key === 'cochlea') focusCochlea();
      else {
        orientPoint(choice.point);
        selectStructure(choice.structureId, false);
        viewer?.focusSurface(choice.point);
      }
    });
    chip.append(button);
  }
  chip.hidden = false;
}

function syncPhoneFabs(): void {
  const boneFab = workspace.querySelector<HTMLButtonElement>('#bone-fab');
  if (boneFab) {
    boneFab.textContent = t('bone.short');
    boneFab.setAttribute('aria-label', boneBtn.textContent || t('bone.transparent'));
    boneFab.setAttribute('aria-pressed', String(viewer?.boneIsTransparent() === true));
  }
  workspace.querySelector('#fit-btn')?.setAttribute('aria-label', t('stage.fit'));
  workspace.querySelector('#label-fab')?.setAttribute('aria-label', t('menu.labels'));
}

function renderLabelPop(): void {
  const pop = workspace.querySelector<HTMLElement>('#label-pop');
  if (!pop) return;
  pop.replaceChildren();
  for (const modeName of ['basic', 'surgical', 'all'] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = t(`labels.${modeName}`);
    button.setAttribute('aria-pressed', String(labelMode === modeName));
    button.addEventListener('click', () => {
      labelMode = modeName;
      viewer?.setLabelMode(labelMode);
      pop.hidden = true;
      paintStatic();
    });
    pop.append(button);
  }
}

function renderPhoneMenu(): void {
  let button = document.querySelector<HTMLButtonElement>('#menu-btn');
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.id = 'menu-btn';
    button.className = 'menu-btn phone-only';
    button.textContent = '☰';
    header.append(button);
    const menu = document.createElement('div');
    menu.id = 'app-menu';
    menu.className = 'app-menu phone-only';
    menu.hidden = true;
    document.body.append(menu);
    button.addEventListener('click', () => {
      menu.hidden = !menu.hidden;
      if (!menu.hidden) fillMenu(menu);
    });
    menu.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const action = target?.closest<HTMLElement>('[data-menu]')?.dataset.menu;
      if (action === 'overview') {
        menu.hidden = true;
        flyStage('body');
        renderPeek();
        renderInfo();
        renderChips();
      } else if (action === 'help') {
        menu.hidden = true;
        openGuide();
      } else if (action === 'style') {
        menu.hidden = true;
        styleBtn.click();
      }
    });
  }
  button.setAttribute('aria-label', t('menu.open'));
  const menu = document.querySelector<HTMLElement>('#app-menu');
  if (menu && !menu.hidden) fillMenu(menu);
}

function fillMenu(menu: HTMLElement): void {
  menu.innerHTML = `
    <a href="${pageUrl('')}">${escapeHtml(t('nav.home'))}</a>
    <a href="${pageUrl('about')}">${escapeHtml(t('nav.about'))}</a>
    <button type="button" data-menu="overview">${escapeHtml(t('menu.overview'))}</button>
    <button type="button" data-menu="help">${escapeHtml(t('menu.help'))}</button>
    <button type="button" data-menu="style">${escapeHtml(renderStyle === 'atlas' ? t('style.model') : t('style.atlas'))}</button>
  `;
}

function renderBackChip(): void {
  const chip = workspace.querySelector<HTMLButtonElement>('#back-chip');
  if (!chip) return;
  const stage = (['body', 'ear', 'bone', 'inner'] as const).find((id) => stageName === id);
  const show = layoutKind() === 'phone' && Boolean(selected) && Boolean(stage);
  const appeared = show && chip.hidden;
  chip.hidden = !show;
  if (show && stage) chip.textContent = t('stage.back', { stage: t(`crumbs.${stage}`) });
  if (appeared) {
    chip.style.pointerEvents = 'none';
    window.setTimeout(() => {
      chip.style.pointerEvents = '';
    }, 450);
  }
}

function currentStage(): ViewStage {
  return (['body', 'ear', 'bone', 'inner'] as const).find((id) => stageName === id) ?? 'body';
}

function refitStage(): void {
  selected = null;
  selectionTitle = null;
  activeStep = null;
  crosshair = null;
  viewer?.setCrosshair(null);
  viewer?.select(null, false);
  hidePicker();
  flyStage(currentStage());
  if (layoutKind() === 'phone') applySnap('peek');
  renderPeek();
  renderInfo();
  renderChips();
  renderPresets();
  void drawCt();
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
  syncSliders();
  if (pacsOpen) syncPacsMarker();
  void drawCt();
  void paintPanes();
  void syncFloatPlanes();
}

function syncSliders(): void {
  if (!volume) return;
  const count = volume.dims[volume.planes[activePlane].axis];
  for (const id of ['#ct-index', '#pacs-index']) {
    const slider = workspace.querySelector<HTMLInputElement>(id);
    if (!slider) continue;
    slider.max = String(Math.max(0, count - 1));
    slider.value = String(planeState[activePlane].index);
  }
  pacsRoot.querySelectorAll<HTMLElement>('.pacs-pane').forEach((pane) => {
    const plane = pane.dataset.plane as SliceName | undefined;
    const slider = pane.querySelector<HTMLInputElement>('.pacs-slider');
    if (!plane || !slider) return;
    const axisCount = volume!.dims[volume!.planes[plane].axis];
    slider.max = String(Math.max(0, axisCount - 1));
    slider.value = String(planeState[plane].index);
  });
}

function setWindow(next: { width: number; level: number }): void {
  windowWidth = next.width;
  windowLevel = next.level;
  const widthInput = workspace.querySelector<HTMLInputElement>('#ct-window');
  const levelInput = workspace.querySelector<HTMLInputElement>('#ct-level');
  if (widthInput) widthInput.value = String(windowWidth);
  if (levelInput) levelInput.value = String(windowLevel);
}

function focusPlane(plane: SliceName): void {
  activePlane = plane;
  pacsShow = plane;
  if (pacsOpen) document.body.dataset.pacsShow = plane;
  ctPlanes.querySelectorAll('button').forEach((item) => item.classList.toggle('is-active', item.dataset.ctPlane === plane));
  pacsRoot.querySelectorAll<HTMLElement>('.pacs-pane').forEach((pane) => {
    pane.classList.toggle('is-active', pane.dataset.plane === plane);
  });
  pacsRoot.querySelectorAll<HTMLButtonElement>('#pacs-planes button').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.pacsPlane === plane);
  });
  syncSliders();
  renderOrient();
}

function showVolume(): void {
  pacsShow = '3d';
  document.body.dataset.pacsShow = '3d';
  pacsRoot.querySelectorAll('.pacs-pane').forEach((pane) => pane.classList.remove('is-active'));
  pacsRoot.querySelectorAll<HTMLButtonElement>('#pacs-planes button').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.pacsPlane === '3d');
  });
}

function setPacs(open: boolean): void {
  if (pacsOpen === open) return;
  pacsOpen = open;
  document.body.classList.toggle('is-pacs', open);
  pacsRoot.hidden = !open;
  syncVisibleRect();
  const openBtn = workspace.querySelector<HTMLButtonElement>('#ct-open');
  if (openBtn) {
    openBtn.dataset.i18n = open ? 'ct.pacsClose' : 'ct.pacsOpen';
    openBtn.textContent = t(openBtn.dataset.i18n);
    openBtn.setAttribute('aria-pressed', String(open));
  }
  if (!open) {
    document.body.dataset.pacsShow = '';
    syncPacsMarker();
    syncCrosshair();
    return;
  }
  if (!crosshair) activePlane = 'coronal';
  focusPlane(activePlane);
  if (portraitPhone()) applySnap('peek');
  if (!crosshair && volume) {
    orientPoint(slicePose(volume, activePlane, planeState[activePlane].index).position);
    requestAnimationFrame(() => syncLabelInset());
    return;
  }
  syncPacsMarker();
  syncCrosshair();
  void paintPanes();
  void drawCt();
  requestAnimationFrame(() => syncLabelInset());
}

function refreshPlaneButtons(): void {
  workspace.querySelectorAll<HTMLButtonElement>('[data-ct-plane]').forEach((button) => {
    const plane = button.dataset.ctPlane as SliceName;
    button.textContent = t(`ct.anatomical.${anatomicalPlaneName(plane)}`);
  });
  workspace.querySelectorAll<HTMLButtonElement>('[data-pacs-plane]').forEach((button) => {
    const plane = button.dataset.pacsPlane;
    button.textContent = plane === '3d' ? t('ct.view3d') : t(`ct.anatomical.${anatomicalPlaneName(plane as SliceName)}`);
  });
  const tool = workspace.querySelector<HTMLButtonElement>('#pacs-tool');
  if (tool) tool.textContent = t(pacsTool === 'window' ? 'ct.tool.window' : 'ct.tool.scroll');
}

function stepPlane(plane: SliceName, delta: number): void {
  if (!volume || delta === 0) return;
  const count = volume.dims[volume.planes[plane].axis];
  const next = scrollIndex(planeState[plane].index, delta, count);
  if (next === planeState[plane].index) return;
  focusPlane(plane);
  const base = crosshair ?? slicePose(volume, plane, planeState[plane].index).position;
  orientPoint(movePointToSlice(volume, plane, next, base));
}

function onSliceSlider(value: number): void {
  if (!volume) return;
  const count = volume.dims[volume.planes[activePlane].axis];
  const next = clampIndex(value, count);
  const base = crosshair ?? slicePose(volume, activePlane, planeState[activePlane].index).position;
  orientPoint(movePointToSlice(volume, activePlane, next, base));
}

function withRaw<T>(work: () => Promise<T>): Promise<T> {
  const run = rawLock.then(work, work);
  rawLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function orientedBitmap(plane: SliceName, index: number): Promise<HTMLCanvasElement | null> {
  return withRaw(async () => {
    if (!volume) return null;
    const url = assetUrl(
      `${DATA}/${sliceFile(volume.planes[plane].folder, index, volume.index_digits, volume.file_extension)}`,
    );
    const image = await loadImage(url);
    const rawCtx = rawCanvas.getContext('2d', { willReadFrequently: true });
    if (!rawCtx) return null;
    if (rawCanvas.width !== image.naturalWidth || rawCanvas.height !== image.naturalHeight) {
      rawCanvas.width = image.naturalWidth;
      rawCanvas.height = image.naturalHeight;
    }
    let raw = rawCache.get(url);
    if (!raw) {
      rawCtx.drawImage(image, 0, 0);
      raw = rawCtx.getImageData(0, 0, rawCanvas.width, rawCanvas.height);
      rawCache.set(url, raw);
    } else rawCtx.putImageData(raw, 0, 0);
    const out = rawCtx.createImageData(raw.width, raw.height);
    remapGray(raw.data, windowWidth, windowLevel, out.data);
    rawCtx.putImageData(out, 0, 0);
    const orient = ctDisplayOrient(plane);
    const size = displayedSize(orient, raw.width, raw.height);
    let target = orientedScratch.get(plane);
    if (!target) {
      target = document.createElement('canvas');
      orientedScratch.set(plane, target);
    }
    if (target.width !== size.width || target.height !== size.height) {
      target.width = size.width;
      target.height = size.height;
    }
    const ctx = target.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.save();
    ctx.translate(size.width / 2, size.height / 2);
    ctx.scale(orient.flipX ? -1 : 1, orient.flipY ? -1 : 1);
    ctx.rotate((orient.turnsCW * Math.PI) / 2);
    ctx.drawImage(rawCanvas, -raw.width / 2, -raw.height / 2);
    ctx.restore();
    return target;
  });
}

function strokeCross(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): void {
  ctx.save();
  ctx.strokeStyle = '#ffe14a';
  ctx.lineWidth = Math.max(1, width / 320);
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.moveTo(0, y);
  ctx.lineTo(width, y);
  ctx.stroke();
  ctx.restore();
}

function drawContours(
  ctx: CanvasRenderingContext2D,
  plane: SliceName,
  index: number,
  width: number,
  height: number,
): void {
  if (!volume || !viewer || !contoursOn || pacsDragging) return;
  const key = `${plane}:${index}`;
  let segments = contourCache.get(key);
  if (!segments) {
    const pose = slicePose(volume, plane, index);
    segments = contoursOnPlane(viewer.contourSources(true), pose.position, pose.normal);
    contourCache.set(key, segments);
  }
  const orient = ctDisplayOrient(plane);
  ctx.save();
  ctx.lineWidth = Math.max(1, width / 220);
  for (const segment of segments) {
    const a = sliceFractions(volume, plane, index, segment.a);
    const b = sliceFractions(volume, plane, index, segment.b);
    const start = displayPoint(orient, a.col01, a.row01, width, height);
    const end = displayPoint(orient, b.col01, b.row01, width, height);
    ctx.strokeStyle = segment.color;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }
  ctx.restore();
}

function paneHud(plane: SliceName, index: number): void {
  if (!volume) return;
  const pane = pacsRoot.querySelector<HTMLElement>(`.pacs-pane[data-plane="${plane}"]`);
  if (!pane) return;
  const labels = displayedEdgeLabels(plane);
  const mark = (side: string, text: string) => {
    const node = pane.querySelector<HTMLElement>(`.pacs-mark.${side}`);
    if (node) node.textContent = text;
  };
  mark('left', labels.left);
  mark('top', labels.top);
  mark('right', labels.right);
  mark('bottom', labels.bottom);
  const pose = slicePose(volume, plane, index);
  const axis = volume.planes[plane].axis;
  const im = pane.querySelector<HTMLElement>('.pacs-im');
  const wl = pane.querySelector<HTMLElement>('.pacs-wl');
  const name = pane.querySelector<HTMLElement>('.pacs-name');
  if (im) im.textContent = formatSliceOverlay(index, volume.dims[axis], pose.position[axis]);
  if (wl) wl.textContent = formatWindowOverlay(windowWidth, windowLevel);
  if (name) name.textContent = t(`ct.anatomical.${anatomicalPlaneName(plane)}`);
}

function blitPane(plane: SliceName, bitmap: HTMLCanvasElement, index: number): void {
  const pane = pacsRoot.querySelector<HTMLElement>(`.pacs-pane[data-plane="${plane}"]`);
  const canvas = pane?.querySelector<HTMLCanvasElement>('canvas');
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx || !volume) return;
  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  drawContours(ctx, plane, index, canvas.width, canvas.height);
  if (crosshair) {
    const orient = ctDisplayOrient(plane);
    const frac = sliceFractions(volume, plane, index, crosshair);
    const at = displayPoint(orient, frac.col01, frac.row01, canvas.width, canvas.height);
    strokeCross(ctx, at.x, at.y, canvas.width, canvas.height);
  }
  drawPaneLabels(ctx, plane, index);
  paneHud(plane, index);
}

let paintToken = 0;
let pacsDragging = false;

async function paintPanes(): Promise<void> {
  if (!pacsOpen || !volume) return;
  const token = ++paintToken;
  const planes: SliceName[] =
    singlePlanePacs() ? [pacsShow === '3d' ? activePlane : pacsShow] : ['coronal', 'sagittal', 'axial'];
  for (const plane of planes) {
    if (token !== paintToken) return;
    const index = planeState[plane].index;
    const bitmap = await orientedBitmap(plane, index);
    if (token !== paintToken || !bitmap || planeState[plane].index !== index) continue;
    blitPane(plane, bitmap, index);
    const count = volume.dims[volume.planes[plane].axis];
    for (const delta of [-1, 1]) {
      const neighbor = index + delta;
      if (neighbor < 0 || neighbor >= count) continue;
      const url = assetUrl(
        `${DATA}/${sliceFile(volume.planes[plane].folder, neighbor, volume.index_digits, volume.file_extension)}`,
      );
      void loadImage(url);
    }
  }
}

function drawPaneLabels(ctx: CanvasRenderingContext2D, plane: SliceName, index: number): void {
  const orient = ctDisplayOrient(plane);
  ctx.save();
  ctx.font = '12px sans-serif';
  ctx.textBaseline = 'top';
  const nearby = ctLabels
    .filter((label) => label.plane === plane && Math.abs(label.slice_index - index) <= 6)
    .sort((a, b) => Math.abs(a.slice_index - index) - Math.abs(b.slice_index - index))
    .slice(0, 6);
  for (const label of nearby) {
    const at = displayPoint(orient, label.xy[0], label.xy[1], ctx.canvas.width, ctx.canvas.height);
    const en = label.en.trim();
    const ko = label.ko.trim();
    const enWidth = Math.min(ctx.measureText(en).width + 8, ctx.canvas.width * 0.46);
    ctx.fillStyle = 'rgba(20,16,12,0.72)';
    ctx.fillRect(at.x + 6, at.y - 2, enWidth, ko && ko !== en ? 28 : 16);
    ctx.fillStyle = '#f7f5f0';
    ctx.fillText(en, at.x + 10, at.y, enWidth - 8);
    if (ko && ko.toLowerCase() !== en.toLowerCase()) {
      ctx.fillStyle = '#d9d3c7';
      ctx.fillText(ko, at.x + 10, at.y + 13, enWidth - 8);
    }
  }
  ctx.restore();
}

function displayPoint(orient: ReturnType<typeof ctDisplayOrient>, col01: number, row01: number, width: number, height: number): { x: number; y: number } {
  const mapped = mapRawToDisplay(orient, col01, row01);
  return { x: mapped.u * width, y: mapped.v * height };
}

async function drawCt(): Promise<void> {
  if (!volume) return;
  const plane = activePlane;
  const index = planeState[plane].index;
  const bitmap = await orientedBitmap(plane, index);
  const ctx = ctCanvas.getContext('2d');
  if (!bitmap || !ctx || planeState[plane].index !== index) return;
  if (ctCanvas.width !== bitmap.width || ctCanvas.height !== bitmap.height) {
    ctCanvas.width = bitmap.width;
    ctCanvas.height = bitmap.height;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctCanvas.width, ctCanvas.height);
  ctx.drawImage(bitmap, 0, 0);
  const orient = ctDisplayOrient(plane);
  drawContours(ctx, plane, index, ctCanvas.width, ctCanvas.height);
  if (crosshair && ctPanelVisible(sheetSnap, desktopLayout())) {
    const frac = sliceFractions(volume, plane, index, crosshair);
    const at = displayPoint(orient, frac.col01, frac.row01, ctCanvas.width, ctCanvas.height);
    ctx.strokeStyle = '#8C2F1B';
    ctx.beginPath();
    ctx.moveTo(at.x, 0);
    ctx.lineTo(at.x, ctCanvas.height);
    ctx.moveTo(0, at.y);
    ctx.lineTo(ctCanvas.width, at.y);
    ctx.stroke();
  }
  const pose = slicePose(volume, plane, index);
  const axis = volume.planes[plane].axis;
  ctReadout.textContent = `${t(`ct.anatomical.${anatomicalPlaneName(plane)}`)} ${formatSliceOverlay(index, volume.dims[axis], pose.position[axis])}`;
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
      focusPlane(plane);
      void drawCt();
      void paintPanes();
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
  slider.addEventListener('input', () => onSliceSlider(Number(slider.value)));
  const phoneSlider = workspace.querySelector<HTMLInputElement>('#pacs-index');
  phoneSlider?.addEventListener('input', () => onSliceSlider(Number(phoneSlider.value)));
  pacsRoot.querySelectorAll<HTMLInputElement>('.pacs-slider').forEach((slider) => {
    const pane = slider.closest<HTMLElement>('.pacs-pane');
    const plane = pane?.dataset.plane as SliceName | undefined;
    if (!plane) return;
    slider.addEventListener('input', () => {
      const next = Number(slider.value);
      focusPlane(plane);
      onSliceSlider(next);
    });
  });
  workspace.querySelector<HTMLInputElement>('#ct-window')?.addEventListener('input', (event) => {
    windowWidth = Number((event.target as HTMLInputElement).value);
    void drawCt();
    void paintPanes();
  });
  workspace.querySelector<HTMLInputElement>('#ct-level')?.addEventListener('input', (event) => {
    windowLevel = Number((event.target as HTMLInputElement).value);
    void drawCt();
    void paintPanes();
  });
  workspace.querySelector('#ct-preset-bone')?.addEventListener('click', () => {
    setWindow(WINDOW_PRESETS.bone);
    void drawCt();
    void paintPanes();
  });
  workspace.querySelector('#ct-preset-soft')?.addEventListener('click', () => {
    setWindow(WINDOW_PRESETS.soft);
    void drawCt();
    void paintPanes();
  });
  workspace.querySelector('#ct-open')?.addEventListener('click', () => {
    const next = !pacsOpen;
    if (next && layoutKind() !== 'desktop') applySheetTab('ct');
    else setPacs(next);
  });
  workspace.querySelector('#pacs-close')?.addEventListener('click', () => {
    if (layoutKind() !== 'desktop') applySheetTab('structures');
    setPacs(false);
  });
  workspace.querySelector('#pacs-tool')?.addEventListener('click', () => {
    pacsTool = pacsTool === 'scroll' ? 'window' : 'scroll';
    refreshPlaneButtons();
  });
  const phonePlanes = workspace.querySelector<HTMLElement>('#pacs-planes');
  if (phonePlanes) {
    phonePlanes.replaceChildren();
    for (const id of ['coronal', 'sagittal', 'axial', '3d'] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.pacsPlane = id;
      button.textContent = id === '3d' ? t('ct.view3d') : t(`ct.anatomical.${anatomicalPlaneName(id)}`);
      button.addEventListener('click', () => {
        if (id === '3d') showVolume();
        else {
          focusPlane(id);
          void paintPanes();
        }
      });
      phonePlanes.append(button);
    }
  }
  workspace.querySelector<HTMLInputElement>('#ct-contour')?.addEventListener('change', (event) => {
    contoursOn = (event.target as HTMLInputElement).checked;
    contourCache.clear();
    void drawCt();
    void paintPanes();
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
  bindPaneGestures();
  window.addEventListener('keydown', (event) => {
    if (!pacsOpen || !volume) return;
    const tag = (event.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    stepPlane(activePlane, event.key === 'ArrowDown' ? 1 : -1);
  });
  renderOrient();
  focusPlane(activePlane);
  void drawCt();
}

type PaneDrag = {
  id: number;
  plane: SliceName;
  x: number;
  y: number;
  lastY: number;
  carried: number;
  mode: 'pending' | 'scroll' | 'window';
  button: number;
  pointers: number;
  startW: number;
  startL: number;
};
let paneDrag: PaneDrag | null = null;

function bindPaneGestures(): void {
  pacsRoot.querySelectorAll<HTMLElement>('.pacs-pane').forEach((pane) => {
    const plane = pane.dataset.plane as SliceName;
    const canvas = pane.querySelector<HTMLCanvasElement>('canvas');
    if (!canvas) return;
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    canvas.addEventListener(
      'wheel',
      (event) => {
        if (!pacsOpen) return;
        event.preventDefault();
        stepPlane(plane, event.deltaY > 0 ? 1 : event.deltaY < 0 ? -1 : 0);
      },
      { passive: false },
    );
    canvas.addEventListener('pointerdown', (event) => {
      if (!volume || !pacsOpen) return;
      if (paneDrag && event.pointerId !== paneDrag.id) {
        paneDrag.mode = 'window';
        paneDrag.pointers = 2;
        paneDrag.x = event.clientX;
        paneDrag.y = event.clientY;
        paneDrag.startW = windowWidth;
        paneDrag.startL = windowLevel;
        pacsDragging = true;
        return;
      }
      focusPlane(plane);
      canvas.setPointerCapture(event.pointerId);
      paneDrag = {
        id: event.pointerId,
        plane,
        x: event.clientX,
        y: event.clientY,
        lastY: event.clientY,
        carried: 0,
        mode: 'pending',
        button: event.button,
        pointers: 1,
        startW: windowWidth,
        startL: windowLevel,
      };
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!paneDrag || event.pointerId !== paneDrag.id) return;
      if (paneDrag.mode === 'pending') {
        if (Math.hypot(event.clientX - paneDrag.x, event.clientY - paneDrag.y) < 6) return;
        const windowing = paneDrag.button === 2 || paneDrag.pointers > 1 || pacsTool === 'window';
        paneDrag.mode = windowing ? 'window' : 'scroll';
        paneDrag.lastY = event.clientY;
        pacsDragging = true;
        return;
      }
      if (paneDrag.mode === 'scroll') {
        const step = consumeDragSteps(paneDrag.carried, event.clientY - paneDrag.lastY);
        paneDrag.carried = step.carried;
        paneDrag.lastY = event.clientY;
        if (step.steps) stepPlane(paneDrag.plane, step.steps);
        return;
      }
      setWindow(dragWindowLevel({ width: paneDrag.startW, level: paneDrag.startL }, event.clientX - paneDrag.x, event.clientY - paneDrag.y));
      void drawCt();
      void paintPanes();
    });
    const finish = (event: PointerEvent) => {
      if (!paneDrag || event.pointerId !== paneDrag.id) return;
      const drag = paneDrag;
      paneDrag = null;
      pacsDragging = false;
      if (drag.mode === 'pending' && volume) {
        const box = canvas.getBoundingClientRect();
        const content = containedRect(
          { width: box.width, height: box.height },
          { width: canvas.width, height: canvas.height },
        );
        const x = event.clientX - box.left;
        const y = event.clientY - box.top;
        if (x >= content.x && y >= content.y && x <= content.x + content.width && y <= content.y + content.height) {
          const raw = mapDisplayToRaw(ctDisplayOrient(drag.plane), (x - content.x) / content.width, (y - content.y) / content.height);
          orientPoint(pointOnSlice(volume, drag.plane, planeState[drag.plane].index, raw.u, raw.v));
          return;
        }
      }
      void paintPanes();
      void drawCt();
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);
  });
}

function onPick(hit: PickHit | null): void {
  if (hit && isNavShell(hit.structureId)) {
    const others = (hit.overlaps ?? []).map((item) => item.structureId);
    const stage = (['body', 'ear', 'bone', 'inner'] as const).find((id) => stageName === id) ?? 'body';
    if (!shouldStageJump(hit.structureId, others, stage)) {
      const real = (hit.overlaps ?? []).find((item) => !isNavShell(item.structureId));
      if (real) {
        hidePicker();
        orientPoint(real.pointMm);
        selectStructure(real.structureId, false);
        viewer?.focusSurface(real.pointMm);
      }
      return;
    }
    if (!eacMm) return;
    const distance = Math.hypot(hit.pointMm[0] - eacMm[0], hit.pointMm[1] - eacMm[1], hit.pointMm[2] - eacMm[2]);
    if (hit.structureId === 'ear-hotspot' || distance < 48) flyStage(stage === 'body' ? 'ear' : 'bone');
    return;
  }
  if (mode === 'quiz' && quiz && !quiz.answered && quiz.question.mode === 'locate') {
    if (hit) answerQuiz(hit.structureId);
    return;
  }
  if (mode !== 'view') return;
  if (!hit) {
    selected = null;
    selectionTitle = null;
    viewer?.select(null, false);
    hidePicker();
    renderPeek();
    renderInfo();
    renderChips();
    renderBackChip();
    return;
  }
  const choices = groupedOverlaps(hit);
  if (groupPickId(hit.structureId) === 'cochlea' && choices.length < 2) {
    hidePicker();
    orientPoint(hit.pointMm);
    selectStructure(hit.structureId.startsWith('scala-') ? hit.structureId : 'scala-vestibuli', false, { ko: '와우', en: 'Cochlea' });
    viewer?.focusSurface(hit.pointMm);
    return;
  }
  if (choices.length > 1) {
    showPicker(choices);
    viewer?.focusSurface(hit.pointMm);
    return;
  }
  hidePicker();
  orientPoint(hit.pointMm);
  selectStructure(hit.structureId, false);
  viewer?.focusSurface(hit.pointMm);
}

function onDouble(hit: PickHit): void {
  if (mode !== 'view') return;
  hidePicker();
  const structureId = hit.overlaps?.[0]?.structureId ?? hit.structureId;
  const ranked = structureId === hit.structureId ? hit : { ...hit, structureId };
  if (isNavShell(ranked.structureId)) {
    onPick(ranked);
    return;
  }
  orientPoint(ranked.pointMm);
  if (groupPickId(ranked.structureId) === 'cochlea') {
    selectStructure(ranked.structureId.startsWith('scala-') ? ranked.structureId : 'scala-vestibuli', false, { ko: '와우', en: 'Cochlea' });
    viewer?.frameIds(COCHLEA_PARTS);
    lowerSheetAfterFit();
    return;
  }
  selectStructure(ranked.structureId, true);
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
workspace.querySelector('#frame-btn')?.addEventListener('click', () => refitStage());
workspace.querySelector('#fit-btn')?.addEventListener('click', () => refitStage());
workspace.querySelector('#back-chip')?.addEventListener('click', () => refitStage());
workspace.querySelector('#bone-fab')?.addEventListener('click', () => boneBtn.click());
workspace.querySelector('#label-fab')?.addEventListener('click', () => {
  const pop = workspace.querySelector<HTMLElement>('#label-pop');
  if (!pop) return;
  pop.hidden = !pop.hidden;
  if (!pop.hidden) renderLabelPop();
});
workspace.querySelectorAll<HTMLButtonElement>('[data-section]').forEach((button) => {
  button.addEventListener('click', () => {
    const id = button.dataset.section;
    if (id === 'presets' || id === 'ct' || id === 'list') openSection(id);
  });
});
workspace.querySelectorAll<HTMLButtonElement>('#sheet-tabs button').forEach((button) => {
  button.addEventListener('click', () => {
    const tab = button.dataset.tab;
    if (tab === 'structures' || tab === 'ct' || tab === 'info') applySheetTab(tab);
  });
});
document.getElementById('guide-dismiss')?.addEventListener('click', () => dismissGuide());
document.getElementById('help-btn')?.addEventListener('click', () => openGuide());
applySheetTab('structures');
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
  syncPhoneFabs();
});
let sheetDrag: { y: number; snap: SheetSnap; pointer: number; interactive: boolean; lastY: number; lastT: number; velocity: number } | null = null;
let sheetMoved = false;
const sheetHead = workspace.querySelector<HTMLElement>('#sheet-head') ?? sheetToggle;
sheetHead.style.touchAction = 'none';
sheetToggle.style.touchAction = 'none';
sheetHead.addEventListener('pointerdown', (event) => {
  if (!portraitPhone()) return;
  const target = event.target as HTMLElement | null;
  const interactive = Boolean(target?.closest('button')) && !target?.closest('.sheet-handle');
  sheetDrag = { y: event.clientY, snap: sheetSnap, pointer: event.pointerId, interactive, lastY: event.clientY, lastT: performance.now(), velocity: 0 };
  sheetHead.setPointerCapture(event.pointerId);
});
sheetHead.addEventListener(
  'touchmove',
  (event) => {
    if (!sheetDrag) return;
    event.preventDefault();
  },
  { passive: false },
);
sheetHead.addEventListener('pointermove', (event) => {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointer || !portraitPhone()) return;
  if (Math.abs(event.clientY - sheetDrag.y) > 8) sheetMoved = true;
  const now = performance.now();
  const dt = now - sheetDrag.lastT;
  if (dt > 0) sheetDrag.velocity = (event.clientY - sheetDrag.lastY) / dt;
  sheetDrag.lastY = event.clientY;
  sheetDrag.lastT = now;
  const next = Math.max(72, sheetCoverPx(sheetDrag.snap, window.innerHeight) + safeInset('bottom') - (event.clientY - sheetDrag.y));
  document.documentElement.style.setProperty('--sheet-cover', `${next}px`);
  syncLabelInset();
});
sheetHead.addEventListener(
  'click',
  (event) => {
    if (!sheetMoved) return;
    event.preventDefault();
    event.stopPropagation();
    sheetMoved = false;
  },
  true,
);
sheetHead.addEventListener('pointerup', (event) => {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointer) return;
  const delta = event.clientY - sheetDrag.y;
  const start = sheetDrag;
  sheetDrag = null;
  if (!portraitPhone()) return;
  if (Math.abs(delta) < 10) {
    if (!start.interactive) applySnap(nextSnap(start.snap));
  } else applySnap(snapAfterDrag(start.snap, delta, window.innerHeight, start.velocity));
});
sheetHead.addEventListener('pointercancel', () => {
  sheetDrag = null;
  applySnap(sheetSnap);
});
searchInput.addEventListener('input', () => {
  renderChips();
  if (portraitPhone() && searchInput.value.trim()) openSection('list');
  if (landscapePhone() && searchInput.value.trim()) {
    document.getElementById('list-section')?.scrollIntoView({ block: 'start' });
  }
});

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
    button.addEventListener('click', () => {
      if (stageName === step.id) refitStage();
      else flyStage(step.id);
    });
    crumbs.append(button);
  });
  const seg = workspace.querySelector<HTMLElement>('#stage-seg');
  const stageTitle = workspace.querySelector<HTMLElement>('#phone-stage');
  const current = steps.find((step) => stageName === step.id);
  if (stageTitle) stageTitle.textContent = current ? t(current.key) : '';
  if (!seg) return;
  seg.replaceChildren();
  for (const step of steps) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.textContent = t(step.key);
    button.classList.toggle('is-active', stageName === step.id);
    button.setAttribute('aria-selected', String(stageName === step.id));
    button.addEventListener('click', () => {
      if (stageName === step.id) refitStage();
      else flyStage(step.id);
    });
    seg.append(button);
  }
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
  if (searchInput.value) {
    searchInput.value = '';
    renderChips();
  }
  selected = null;
  selectionTitle = null;
  hidePicker();
  viewer.clearPreset();
  viewer.select(null, false);
  viewer.setMarker(null, '');
  viewer.setViewContext(stage, null);
  viewer.setBoneTransparent(stage === 'inner');
  viewer.setShellOpen(stage === 'bone' || stage === 'inner');
  viewer.setStageHidden(hiddenForStage(stage, manifest.structures.map((item) => item.id)));
  viewer.setCutaway(0, 1);
  const limits = STAGE_LIMITS[stage];
  viewer.setDistanceLimits(limits.min, limits.max);
  syncVisibleRect();
  const box = stageBox(stage);
  const view = STAGE_VIEW[stage];
  if (box) {
    const width = Math.max(canvas.clientWidth, 1);
    const height = Math.max(canvas.clientHeight, 1);
    const visible = pacsOpen ? null : phoneVisible();
    const pose = frameAabb({
      box,
      direction: view.direction,
      up: view.up,
      fovDeg: visible ? visibleFovDeg(view.fov, height, visible.height) : view.fov,
      viewWidthPx: visible ? visible.width : width,
      viewHeightPx: visible ? visible.height : height,
      margin: view.margin,
    });
    let position = pose.position;
    if (pose.distance < limits.min || pose.distance > limits.max) {
      const distance = Math.min(limits.max, Math.max(limits.min, pose.distance));
      position = placeAlong(pose.target, view.direction, distance);
    }
    viewer.flyTo(position, pose.target, view.up, view.fov);
  }
  boneBtn.textContent = viewer.boneIsTransparent() ? t('bone.solid') : t('bone.transparent');
  boneBtn.setAttribute('aria-label', boneBtn.textContent);
  boneBtn.setAttribute('aria-pressed', String(viewer.boneIsTransparent()));
  syncPhoneFabs();
  renderCrumbs();
  renderPresets();
  renderPeek();
  renderInfo();
  renderChips();
  renderBackChip();
  syncLabelInset();
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
      tier: structure.id === 'tm-pars-flaccida'
        ? 'structure'
        : structure.parent || parents.has(structure.id)
          ? (structure.parent ? 'subpart' : 'structure')
          : 'structure',
      modes,
      priority: structure.id === 'tm-pars-flaccida'
        ? 64
        : corePriority[structure.id] ?? (structure.parent ? 25 : structure.id === 'bone' ? 80 : 48),
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
    if (mode === 'quiz') return;
    hidePicker();
    const regionStage: Record<string, ViewStage> = {
      'region-inner': 'inner',
      'region-middle': 'bone',
      'region-ossicles': 'bone',
      'region-nerve': 'bone',
    };
    const nextStage = regionStage[id];
    if (nextStage) {
      if (currentStage() !== nextStage) flyStage(nextStage);
      const focus =
        id === 'region-middle' || id === 'region-ossicles'
          ? 'tympanic-membrane'
          : id === 'region-nerve'
            ? 'facial-nerve'
            : null;
      if (focus && structureById(focus)) selectStructure(focus, true);
      if (portraitPhone()) applySnap('peek');
      return;
    }
    const action = labelAction(id);
    if (action.kind === 'cochlea') {
      focusCochlea();
      return;
    }
    if (action.kind === 'iac') {
      focusIac();
      return;
    }
    if (structureById(action.structureId)) {
      viewer?.flash(action.structureId);
      selectStructure(action.structureId, true);
      lowerSheetAfterFit();
      return;
    }
    const point = landmarks.find((item) => item.id === id);
    if (point?.parent && structureById(point.parent)) {
      selectStructure(point.parent, true);
      lowerSheetAfterFit();
    }
  });
  viewer.onDoublePick(onDouble);

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
      targetOnScreen: () => viewer?.targetOnScreen() ?? null,
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
  maybeOpenGuide();
  stageStatus.hidden = failures.length === 0;
  if (failures.length) stageStatus.textContent = `${t('temporal.loadError')} ${failures.join(', ')}`;
  paintStatic();
}

applySnap('peek');
window.addEventListener('resize', () => {
  applySnap(sheetSnap);
  syncLabelInset();
  renderBackChip();
  if (pacsOpen) void paintPanes();
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
