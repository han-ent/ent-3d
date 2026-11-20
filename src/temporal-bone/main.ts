import '../styles/app.css';
import { planeAxes, sliceFile, slicePose, clampIndex } from '../shared/ct';
import { applyI18n, getLang, initI18n, onLangChange, t, text } from '../shared/i18n';
import { distanceMm, formatMm } from '../shared/measurement';
import { fetchJson, publicUrl } from '../shared/paths';
import { registerServiceWorker } from '../shared/pwa';
import { grade, makeLocateQuestion, makeNameQuestion, type QuizQuestion } from '../shared/quiz';
import { formatIssues, validateContent, validateManifest, validatePresets, validateVolume } from '../shared/schema';
import type { Manifest, PresetFile, StructureContent, Vec3, VolumeMeta } from '../shared/types';
import { statusBadge } from '../shared/ui/badge';
import { renderFooter, renderHeader } from '../shared/ui/chrome';
import { EntViewer, type PickHit } from '../shared/viewer/Viewer';

const DATA = 'temporal-bone';
const QUIZ_LENGTH = 5;

type PlaneName = 'axial' | 'coronal' | 'sagittal';

type QuizState = {
  kind: 'name' | 'locate';
  question: QuizQuestion;
  score: number;
  total: number;
  answered: boolean;
  feedback: string;
  finished: boolean;
};

initI18n();
registerServiceWorker();

const header = renderHeader('temporal');
const banner = document.createElement('p');
banner.className = 'banner';
banner.dataset.i18n = 'temporal.sampleBanner';

const workspace = document.createElement('div');
workspace.className = 'workspace';
workspace.innerHTML = `
  <div class="stage">
    <canvas id="view"></canvas>
    <div class="stage-status" id="stage-status" data-i18n="temporal.loading"></div>
    <div class="hud">
      <div class="hud-card">
        <span>SAMPLE</span>
        <span class="scale-bar-line" data-scale-line></span>
        <span data-scale-label>10 mm</span>
        <div data-i18n="coord.units"></div>
      </div>
      <div class="hud-card measure-card" id="measure-readout" hidden>
        <div id="measure-text"></div>
        <button type="button" id="measure-clear" data-i18n="measure.clear"></button>
      </div>
    </div>
    <div class="modebar" role="toolbar">
      <button type="button" data-mode="view" data-i18n="mode.view"></button>
      <button type="button" data-mode="measure" data-i18n="mode.measure"></button>
      <button type="button" data-mode="quiz" data-i18n="mode.quiz"></button>
    </div>
  </div>
  <aside class="panel" id="panel">
    <section class="card" id="info-card"></section>
    <section class="card">
      <h2 data-i18n="presets.title"></h2>
      <p class="hint" data-i18n="presets.note"></p>
      <div class="btn-row" id="preset-row"></div>
      <p class="hint" id="clip-note" hidden></p>
    </section>
    <section class="card">
      <h2 data-i18n="layers.title"></h2>
      <div id="layers"></div>
    </section>
    <section class="card">
      <h2 data-i18n="ct.title"></h2>
      <p class="hint" data-i18n="ct.sample"></p>
      <div id="ct-controls"></div>
    </section>
    <section class="card" id="quiz-card" hidden>
      <h2 data-i18n="quiz.title"></h2>
      <div class="btn-row">
        <button type="button" class="btn" id="quiz-name" data-i18n="quiz.nameMode"></button>
        <button type="button" class="btn" id="quiz-locate" data-i18n="quiz.locateMode"></button>
      </div>
      <div id="quiz-body"></div>
      <button type="button" class="btn" id="quiz-exit" data-i18n="quiz.exit"></button>
    </section>
    <section class="card">
      <h2 data-i18n="coord.title"></h2>
      <p class="hint" id="coord-note"></p>
      <p class="hint" id="version-line"></p>
    </section>
  </aside>
`;

const footer = renderFooter();
document.body.className = 'app-body';
document.body.replaceChildren(header, banner, workspace, footer);

const canvas = workspace.querySelector<HTMLCanvasElement>('#view')!;
const stageStatus = workspace.querySelector<HTMLElement>('#stage-status')!;
const measureReadout = workspace.querySelector<HTMLElement>('#measure-readout')!;
const measureText = workspace.querySelector<HTMLElement>('#measure-text')!;
const panel = workspace.querySelector<HTMLElement>('#panel')!;
const infoCard = workspace.querySelector<HTMLElement>('#info-card')!;
const presetRow = workspace.querySelector<HTMLElement>('#preset-row')!;
const clipNote = workspace.querySelector<HTMLElement>('#clip-note')!;
const layersEl = workspace.querySelector<HTMLElement>('#layers')!;
const ctControls = workspace.querySelector<HTMLElement>('#ct-controls')!;
const quizCard = workspace.querySelector<HTMLElement>('#quiz-card')!;
const quizBody = workspace.querySelector<HTMLElement>('#quiz-body')!;
const coordNote = workspace.querySelector<HTMLElement>('#coord-note')!;
const versionLine = workspace.querySelector<HTMLElement>('#version-line')!;

let manifest: Manifest | null = null;
let contents = new Map<string, StructureContent>();
let presets: PresetFile | null = null;
let volume: VolumeMeta | null = null;
let viewer: EntViewer | null = null;
let mode: 'view' | 'measure' | 'quiz' = 'view';
let selected: string | null = null;
let activePreset: string | null = 'frame';
const linked = new Set<string>();
let quiz: QuizState | null = null;
const planeState: Record<PlaneName, { visible: boolean; index: number; opacity: number }> = {
  axial: { visible: false, index: 0, opacity: 0.9 },
  coronal: { visible: false, index: 0, opacity: 0.9 },
  sagittal: { visible: false, index: 0, opacity: 0.9 },
};
const imageCache = new Map<string, Promise<HTMLImageElement>>();

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[char] ?? char;
  });
}

function formatPoint(point: Vec3): string {
  return point.map((value) => value.toFixed(1)).join(', ');
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

function structures() {
  return manifest?.structures ?? [];
}

function contentOf(id: string): StructureContent | undefined {
  return contents.get(id);
}

function paintStatic(): void {
  document.title = `${t('temporal.title')} · ENT 3D`;
  applyI18n(document.body);
  if (manifest) {
    coordNote.textContent = text(manifest.coordinate_system.note);
    versionLine.textContent = `${t('common.version')} ${manifest.model_version}`;
  }
  renderMeasure(viewer?.measurementPoints() ?? []);
  renderInfo();
  renderQuiz();
  renderPresetLabels();
  renderLayerLabels();
  renderCtLabels();
}

function renderPresetLabels(): void {
  presetRow.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((button) => {
    const id = button.dataset.preset;
    if (id === 'frame') button.textContent = t('mode.frame');
    else {
      const preset = presets?.presets.find((item) => item.id === id);
      if (preset) button.textContent = text(preset.name);
    }
    button.classList.toggle('is-active', id === activePreset);
  });
}

function renderLayerLabels(): void {
  if (!manifest) return;
  for (const layer of manifest.layers) {
    const label = layersEl.querySelector<HTMLElement>(`[data-layer-label="${layer.id}"]`);
    if (label) label.textContent = text(layer.name);
  }
  for (const structure of manifest.structures) {
    const label = layersEl.querySelector<HTMLElement>(`[data-structure-label="${structure.id}"]`);
    if (label) label.textContent = text(structure.name);
    const button = layersEl.querySelector<HTMLButtonElement>(`[data-select="${structure.id}"]`);
    button?.classList.toggle('is-active', structure.id === selected);
  }
}

function renderCtLabels(): void {
  const ct = volume;
  if (!ct) return;
  (['axial', 'coronal', 'sagittal'] as const).forEach((plane) => {
    const label = ctControls.querySelector<HTMLElement>(`[data-ct-label="${plane}"]`);
    if (!label) return;
    const axis = ct.planes[plane].axis;
    const count = ct.dims[axis];
    const index = clampIndex(planeState[plane].index, count);
    const pose = slicePose(ct, plane, index);
    const coord = pose.position[planeAxes(plane).normal];
    label.textContent = `${t(`ct.${plane}`)} ${index + 1}/${count} · ${coord.toFixed(1)} mm`;
  });
}

function reviewedHtml(titleKey: string, block: { text: { ko: string; en: string }; source: string; status: string }, slot: string): string {
  return `
    <div class="block">
      <div class="point-head">
        <strong>${escapeHtml(t(titleKey))}</strong>
        <span data-badge="${slot}"></span>
      </div>
      <p>${escapeHtml(text(block.text))}</p>
      <p class="meta">${escapeHtml(t('info.source'))}: ${escapeHtml(block.source)}</p>
    </div>`;
}

function renderInfo(): void {
  if (!manifest || !selected) {
    infoCard.innerHTML = `<p class="hint" data-i18n="info.empty"></p>`;
    applyI18n(infoCard);
    return;
  }
  const structure = manifest.structures.find((item) => item.id === selected);
  const content = structure ? contentOf(structure.id) : undefined;
  if (!structure || !content) {
    infoCard.innerHTML = `<p class="hint" data-i18n="info.empty"></p>`;
    applyI18n(infoCard);
    return;
  }
  const points = content.surgical_points
    .map(
      (point, index) => `
        <li>
          <div class="point-head">
            <strong>${escapeHtml(text(point.title))}</strong>
            <span data-badge="point-${index}"></span>
          </div>
          <p>${escapeHtml(text(point.body))}</p>
          <p class="meta">${escapeHtml(t('info.position'))} ${formatPoint(point.position_mm)} mm</p>
          <p class="meta">${escapeHtml(t('info.source'))}: ${escapeHtml(point.source)}</p>
        </li>`,
    )
    .join('');
  const related = content.related ?? [];
  const relatedHtml = related.length
    ? `<div class="chips">${related
        .map((id) => {
          const linkedTo = manifest!.structures.find((item) => item.id === id);
          const label = linkedTo ? text(linkedTo.name) : id;
          const on = linked.has(id) ? ' is-linked' : '';
          return `<button type="button" class="chip${on}" data-related="${escapeHtml(id)}">${escapeHtml(label)}</button>`;
        })
        .join('')}</div><p class="hint">${escapeHtml(t('info.relatedHint'))}</p>`
    : `<p class="hint">${escapeHtml(t('info.relatedEmpty'))}</p>`;
  infoCard.innerHTML = `
    <h2>${escapeHtml(text(structure.name))} <span class="en-name">${escapeHtml(structure.name.en)}</span></h2>
    <div class="badge-row" id="info-badges"></div>
    <p class="meta">${escapeHtml(t('info.modelVersion'))}: ${escapeHtml(content.model_version)}</p>
    <h3>${escapeHtml(t('info.summary'))}</h3>
    <div class="block">
      <div class="point-head"><span data-badge="anatomy"></span></div>
      <p>${escapeHtml(text(content.info.summary))}</p>
      <p class="meta">${escapeHtml(t('info.source'))}: ${escapeHtml(content.info.source)}</p>
    </div>
    <h3>${escapeHtml(t('info.function'))}</h3>
    ${reviewedHtml('info.physiology', content.function.physiology, 'physiology')}
    ${reviewedHtml('info.injury', content.function.injury, 'injury')}
    ${reviewedHtml('info.tests', content.function.tests, 'tests')}
    <h3>${escapeHtml(t('info.related'))}</h3>
    ${relatedHtml}
    <h3>${escapeHtml(t('info.points'))}</h3>
    <ul class="points">${points}</ul>
  `;
  infoCard.querySelector('#info-badges')?.append(statusBadge(structure.status));
  infoCard.querySelector('[data-badge="anatomy"]')?.append(statusBadge(content.info.status));
  infoCard.querySelector('[data-badge="physiology"]')?.append(statusBadge(content.function.physiology.status));
  infoCard.querySelector('[data-badge="injury"]')?.append(statusBadge(content.function.injury.status));
  infoCard.querySelector('[data-badge="tests"]')?.append(statusBadge(content.function.tests.status));
  content.surgical_points.forEach((point, index) => {
    infoCard.querySelector(`[data-badge="point-${index}"]`)?.append(statusBadge(point.status));
  });
  infoCard.querySelectorAll<HTMLButtonElement>('[data-related]').forEach((button) => {
    button.addEventListener('click', () => toggleRelated(button.dataset.related ?? ''));
  });
}

function toggleRelated(id: string): void {
  if (!manifest || !viewer || !id || mode === 'quiz') return;
  if (linked.has(id)) linked.delete(id);
  else linked.add(id);
  const structure = manifest.structures.find((item) => item.id === id);
  if (structure && linked.has(id)) {
    viewer.setLayerVisible(structure.layer, true);
    const checkbox = layersEl.querySelector<HTMLInputElement>(`[data-layer-visible="${structure.layer}"]`);
    if (checkbox) checkbox.checked = true;
  }
  viewer.link([...linked]);
  renderInfo();
}

function renderMeasure(points: Vec3[]): void {
  measureReadout.hidden = mode !== 'measure';
  if (points.length === 0) measureText.textContent = t('measure.hint');
  else if (points.length === 1) measureText.textContent = `${formatPoint(points[0])}\n${t('measure.needSecond')}`;
  else measureText.textContent = `${t('measure.result')} ${formatMm(distanceMm(points[0]!, points[1]!))}\n${formatPoint(points[0]!)}\n${formatPoint(points[1]!)}`;
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
      <button type="button" class="btn" id="quiz-again" data-i18n="quiz.again"></button>
    `;
    applyI18n(quizBody);
    quizBody.querySelector('#quiz-again')?.addEventListener('click', () => startQuiz(quiz!.kind));
    return;
  }
  const question = quiz.question;
  const score = `<p class="meta">${escapeHtml(t('quiz.score', { score: quiz.score, total: quiz.total }))}</p>`;
  if (question.mode === 'name') {
    const choices = question.choices
      .map((choice) => {
        const mark = quiz!.answered ? (choice.id === question.structureId ? ' is-correct' : '') : '';
        return `<button type="button" class="choice${mark}" data-choice="${escapeHtml(choice.id)}" ${quiz!.answered ? 'disabled' : ''}>${escapeHtml(choice.label)}</button>`;
      })
      .join('');
    quizBody.innerHTML = `
      ${score}
      <p>${escapeHtml(t('quiz.promptName'))}</p>
      <div class="struct-list">${choices}</div>
      <p>${escapeHtml(quiz.feedback)}</p>
      ${quiz.answered ? `<button type="button" class="btn" id="quiz-next">${escapeHtml(t('quiz.next'))}</button>` : ''}
    `;
    quizBody.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach((button) => {
      button.addEventListener('click', () => answerQuiz(button.dataset.choice ?? ''));
    });
  } else {
    quizBody.innerHTML = `
      ${score}
      <p>${escapeHtml(t('quiz.promptLocate'))}</p>
      <p><strong>${escapeHtml(question.label)}</strong></p>
      <p>${escapeHtml(quiz.feedback)}</p>
      ${quiz.answered ? `<button type="button" class="btn" id="quiz-next">${escapeHtml(t('quiz.next'))}</button>` : ''}
    `;
  }
  quizBody.querySelector('#quiz-next')?.addEventListener('click', nextQuestion);
}

function setMode(next: 'view' | 'measure' | 'quiz'): void {
  mode = next;
  viewer?.setMode(next);
  workspace.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.mode === next));
  });
  if (next !== 'quiz') {
    quiz = null;
    viewer?.highlight(selected, false);
    if (selected) viewer?.select(selected);
  }
  renderMeasure(viewer?.measurementPoints() ?? []);
  renderQuiz();
}

function selectStructure(id: string): void {
  selected = id;
  linked.clear();
  viewer?.select(id);
  renderInfo();
  renderLayerLabels();
  panel.scrollTop = 0;
}

function answerQuiz(id: string): void {
  if (!quiz || quiz.answered || quiz.finished) return;
  const correct = grade(quiz.question, id);
  quiz.answered = true;
  quiz.total += 1;
  if (correct) quiz.score += 1;
  quiz.feedback = correct ? t('quiz.correct') : t('quiz.wrong');
  viewer?.highlight(quiz.question.structureId, true);
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
  if (question.mode === 'name') viewer?.highlight(question.structureId, true);
  else viewer?.highlight(null, false);
  renderQuiz();
}

function startQuiz(kind: 'name' | 'locate'): void {
  if (!manifest) return;
  const items = manifest.structures.map((structure) => ({ id: structure.id, name: structure.name }));
  const question = kind === 'name' ? makeNameQuestion(items, getLang()) : makeLocateQuestion(items, getLang());
  quiz = { kind, question, score: 0, total: 0, answered: false, feedback: '', finished: false };
  setMode('quiz');
  if (question.mode === 'name') viewer?.highlight(question.structureId, true);
  else viewer?.highlight(null, false);
  quizCard.hidden = false;
  renderQuiz();
  quizCard.scrollIntoView({ block: 'nearest' });
}

async function syncPlane(plane: PlaneName): Promise<void> {
  if (!viewer || !volume) return;
  const state = planeState[plane];
  const count = volume.dims[volume.planes[plane].axis];
  state.index = clampIndex(state.index, count);
  const pose = slicePose(volume, plane, state.index);
  let image: HTMLImageElement | null = null;
  if (state.visible) {
    const url = publicUrl(`${DATA}/${sliceFile(volume.planes[plane].folder, state.index)}`);
    image = await loadImage(url);
  }
  viewer.setPlane({ id: plane, visible: state.visible, opacity: state.opacity, pose, image });
  renderCtLabels();
}

function buildPresets(): void {
  presetRow.replaceChildren();
  const frame = document.createElement('button');
  frame.type = 'button';
  frame.className = 'btn';
  frame.dataset.preset = 'frame';
  frame.addEventListener('click', () => {
    activePreset = 'frame';
    viewer?.frameAll();
    clipNote.hidden = true;
    renderPresetLabels();
  });
  presetRow.append(frame);
  for (const preset of presets?.presets ?? []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.dataset.preset = preset.id;
    button.addEventListener('click', () => {
      activePreset = preset.id;
      viewer?.applyPreset(preset);
      const clipping = preset.clipping?.enabled === true;
      clipNote.hidden = !clipping;
      clipNote.textContent = clipping ? t('presets.clipOn') : '';
      renderPresetLabels();
    });
    presetRow.append(button);
  }
  renderPresetLabels();
}

function buildLayers(): void {
  if (!manifest) return;
  layersEl.replaceChildren();
  for (const layer of manifest.layers) {
    const block = document.createElement('div');
    block.className = 'layer';
    const visible = layer.visible !== false;
    block.innerHTML = `
      <label class="layer-head">
        <input type="checkbox" data-layer-visible="${layer.id}" ${visible ? 'checked' : ''} />
        <span data-layer-label="${layer.id}"></span>
      </label>
      <label class="opacity">
        <span data-i18n="layers.opacity"></span>
        <input type="range" min="0" max="1" step="0.05" value="${layer.opacity}" data-layer-opacity="${layer.id}" />
      </label>
      <div class="struct-list" data-layer-list="${layer.id}"></div>
    `;
    const list = block.querySelector(`[data-layer-list="${layer.id}"]`)!;
    for (const structure of manifest.structures.filter((item) => item.layer === layer.id)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'struct-btn';
      button.dataset.select = structure.id;
      const name = document.createElement('span');
      name.className = 'struct-name';
      name.dataset.structureLabel = structure.id;
      button.append(name, statusBadge(structure.status));
      button.addEventListener('click', () => {
        if (mode === 'quiz') return;
        setMode('view');
        selectStructure(structure.id);
      });
      list.append(button);
    }
    block.querySelector<HTMLInputElement>('[data-layer-visible]')?.addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement;
      viewer?.setLayerVisible(layer.id, input.checked);
    });
    block.querySelector<HTMLInputElement>('[data-layer-opacity]')?.addEventListener('input', (event) => {
      const input = event.target as HTMLInputElement;
      viewer?.setLayerOpacity(layer.id, Number(input.value));
    });
    layersEl.append(block);
    viewer?.setLayerVisible(layer.id, visible);
    viewer?.setLayerOpacity(layer.id, layer.opacity);
  }
  applyI18n(layersEl);
  renderLayerLabels();
}

function buildCt(): void {
  if (!volume) return;
  ctControls.replaceChildren();
  (['axial', 'coronal', 'sagittal'] as const).forEach((plane) => {
    const count = volume!.dims[volume!.planes[plane].axis];
    planeState[plane].index = Math.floor((count - 1) / 2);
    const block = document.createElement('div');
    block.className = 'ct-block';
    block.innerHTML = `
      <label class="checkline">
        <input type="checkbox" data-ct-show="${plane}" />
        <h3 data-ct-label="${plane}"></h3>
      </label>
      <input type="range" min="0" max="${Math.max(0, count - 1)}" step="1" value="${planeState[plane].index}" data-ct-index="${plane}" aria-label="${plane}" />
    `;
    block.querySelector<HTMLInputElement>('[data-ct-show]')?.addEventListener('change', (event) => {
      planeState[plane].visible = (event.target as HTMLInputElement).checked;
      void syncPlane(plane);
    });
    block.querySelector<HTMLInputElement>('[data-ct-index]')?.addEventListener('input', (event) => {
      planeState[plane].index = Number((event.target as HTMLInputElement).value);
      void syncPlane(plane);
    });
    ctControls.append(block);
  });
  renderCtLabels();
}

function onPick(hit: PickHit): void {
  if (mode === 'quiz' && quiz && !quiz.answered && quiz.question.mode === 'locate') {
    answerQuiz(hit.structureId);
    return;
  }
  if (mode === 'view') selectStructure(hit.structureId);
}

workspace.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
  button.addEventListener('click', () => {
    const next = button.dataset.mode as 'view' | 'measure' | 'quiz';
    if (next === 'quiz') {
      setMode('quiz');
      quizCard.scrollIntoView({ block: 'nearest' });
      return;
    }
    setMode(next);
  });
});

workspace.querySelector('#measure-clear')?.addEventListener('click', () => viewer?.clearMeasurement());
workspace.querySelector('#quiz-name')?.addEventListener('click', () => startQuiz('name'));
workspace.querySelector('#quiz-locate')?.addEventListener('click', () => startQuiz('locate'));
workspace.querySelector('#quiz-exit')?.addEventListener('click', () => setMode('view'));

onLangChange(() => {
  if (quiz && !quiz.finished && manifest) {
    const question = quiz.question;
    if (question.mode === 'locate') {
      const structure = manifest.structures.find((item) => item.id === question.structureId);
      if (structure) question.label = text(structure.name);
    } else {
      question.choices = question.choices.map((choice) => {
        const structure = manifest!.structures.find((item) => item.id === choice.id);
        return { id: choice.id, label: structure ? text(structure.name) : choice.label };
      });
    }
  }
  paintStatic();
});

async function boot(): Promise<void> {
  paintStatic();
  setMode('view');
  const manifestUrl = publicUrl(`${DATA}/manifest.json`);
  const loaded = await fetchJson<Manifest>(manifestUrl);
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
  const presetIssues = validatePresets(presets);
  if (presetIssues.length) throw new Error(formatIssues(presetIssues));

  volume = await fetchJson<VolumeMeta>(publicUrl(`${DATA}/ct/volume.json`));
  const volumeIssues = validateVolume(volume);
  if (volumeIssues.length) throw new Error(formatIssues(volumeIssues));

  viewer = new EntViewer(canvas, manifest.viewer_offset_mm);
  viewer.setScaleElement(workspace.querySelector('.hud-card'));
  viewer.onPick(onPick);
  viewer.onMeasure((points) => renderMeasure(points));

  const failures: string[] = [];
  await Promise.all(
    manifest.structures.map(async (structure) => {
      const layer = manifest!.layers.find((item) => item.id === structure.layer);
      try {
        await viewer!.loadStructure(
          structure.id,
          publicUrl(`${DATA}/${structure.file}`),
          structure.color,
          structure.layer,
          layer?.opacity ?? 1,
        );
      } catch {
        failures.push(structure.id);
      }
    }),
  );

  buildPresets();
  buildLayers();
  buildCt();
  viewer.frameAll();
  activePreset = 'frame';
  stageStatus.hidden = true;
  if (failures.length) {
    banner.textContent = `${t('temporal.loadError')} ${failures.join(', ')}`;
  }
  paintStatic();
}

boot().catch((error: unknown) => {
  stageStatus.hidden = false;
  const message = error instanceof Error ? error.message : String(error);
  stageStatus.textContent = `${t('temporal.loadError')}\n${message}`;
});
