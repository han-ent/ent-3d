import { getLang } from '../shared/i18n';
import { anatomyLines, type LabelLang } from '../shared/label-lang';
import type { VorState } from './engine';
import type { GraphNode, VorBundle } from './types';

export type SheetModel = {
  bundle: VorBundle;
  selected: string | null;
  connected: string[];
  canals: string[];
  labels: LabelLang;
  layoutAnatomic: boolean;
};

const KIND_ORDER = ['canal', 'nucleus', 'tract', 'muscle', 'nerve', 'eye', 'landmark'];

export function nodeById(bundle: VorBundle, id: string): GraphNode | undefined {
  return bundle.graph.nodes.find((node) => node.id === id);
}

export function renderSheet(host: HTMLElement, model: SheetModel, t: (key: string) => string): void {
  const node = model.selected ? nodeById(model.bundle, model.selected) : undefined;
  if (!node) {
    host.innerHTML = `
      <p class="vor-sheet-kicker" data-i18n="vor.kicker"></p>
      <h2 data-i18n="vor.sheetEmpty"></h2>
      <p class="vor-sheet-lead" data-i18n="vor.body"></p>
      ${controlsHtml()}
    `;
    applyStatic(host, t);
    return;
  }
  const lines = anatomyLines(node.nameEn, node.nameKo, model.labels);
  const badge = node.reviewStatus === 'verified' ? t('vor.badgeVerified') : t('vor.badgeUnverified');
  const note = node.note ? node.note[getLang()] || node.note.ko : '';
  const canals = model.canals
    .filter((id) => id !== model.selected)
    .map((id) => nodeById(model.bundle, id))
    .filter((item): item is GraphNode => Boolean(item))
    .map((item) => anatomyLines(item.nameEn, item.nameKo, model.labels));
  const links = model.connected
    .filter((id) => id !== node.id)
    .map((id) => nodeById(model.bundle, id))
    .filter((item): item is GraphNode => Boolean(item))
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.nameEn.localeCompare(b.nameEn));
  const list = links
    .map((item) => {
      const name = anatomyLines(item.nameEn, item.nameKo, model.labels);
      const sub = name.sub ? `<span>${escapeHtml(name.sub)}</span>` : '';
      return `<li><button type="button" data-jump="${item.id}"><strong>${escapeHtml(name.main)}</strong>${sub}</button></li>`;
    })
    .join('');
  const canalBlock =
    canals.length > 0
      ? `<h3>${escapeHtml(t('vor.excitatory'))}</h3><ul class="vor-names">${canals
          .map((name) => `<li><strong>${escapeHtml(name.main)}</strong>${name.sub ? `<span>${escapeHtml(name.sub)}</span>` : ''}</li>`)
          .join('')}</ul>`
      : '';
  host.innerHTML = `
    <p class="vor-badge" data-badge>${escapeHtml(badge)}</p>
    <h2 class="vor-name-main">${escapeHtml(lines.main)}</h2>
    ${lines.sub ? `<p class="vor-name-sub">${escapeHtml(lines.sub)}</p>` : ''}
    <p class="vor-meters" data-meters></p>
    ${canalBlock}
    <h3>${escapeHtml(t('vor.pathway'))}</h3>
    <ul class="vor-names">${list}</ul>
    ${note ? `<p class="vor-note">${escapeHtml(note)}</p>` : ''}
    <details class="vor-source"><summary>${escapeHtml(t('vor.source'))}</summary><p>${escapeHtml(node.source)}</p></details>
    ${model.layoutAnatomic ? `<p class="vor-note" data-i18n="vor.layoutNote"></p>` : ''}
    ${controlsHtml()}
  `;
  applyStatic(host, t);
}

function applyStatic(host: HTMLElement, t: (key: string) => string): void {
  host.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });
}

export function renderMeters(host: HTMLElement, bundle: VorBundle, state: VorState, selected: string | null, t: (key: string) => string): void {
  const slot = host.querySelector<HTMLElement>('[data-meters]');
  if (!slot || !selected) return;
  const node = nodeById(bundle, selected);
  if (!node) return;
  const parts: string[] = [];
  if (node.kind === 'canal') {
    const firing = state.firing[selected] ?? 0;
    const deflection = state.deflection[selected] ?? 0;
    parts.push(`${t('vor.firing')} ${firing.toFixed(0)} spikes/s`);
    parts.push(`${t('vor.deflection')} ${deflection.toFixed(1)} °/s`);
  } else if (node.kind === 'muscle') {
    const drive = state.muscle[selected] ?? 0;
    parts.push(`${t('vor.activation')} ${drive.toFixed(0)}`);
  }
  const eye = node.kind === 'eye' ? (node.side === 'left' ? state.eyePos.left : state.eyePos.right) : null;
  if (eye) {
    const phase = state.fastPhase[node.side === 'left' ? 'left' : 'right'] ? t('vor.fast') : t('vor.slow');
    parts.push(`${phase}  ${eye.map((value) => value.toFixed(1)).join(', ')}°`);
  }
  slot.textContent = parts.join(' · ');
}

function controlsHtml(): string {
  return `
    <div class="vor-sheet-controls">
      <fieldset>
        <legend data-i18n="vor.hypo"></legend>
        <div class="vor-seg" data-group="hypo">
          <button type="button" data-hypo="off" data-i18n="vor.hypoOff"></button>
          <button type="button" data-hypo="right" data-i18n="vor.hypoRight"></button>
          <button type="button" data-hypo="left" data-i18n="vor.hypoLeft"></button>
        </div>
      </fieldset>
      <fieldset>
        <legend data-i18n="vor.layout"></legend>
        <button type="button" class="vor-wide" data-layout data-i18n="vor.layoutSpread"></button>
        <p class="vor-hint" data-i18n="vor.layoutNote"></p>
      </fieldset>
      <fieldset>
        <legend data-i18n="vor.time"></legend>
        <div class="vor-time">
          <button type="button" data-pause data-i18n="vor.pause"></button>
          <button type="button" data-step data-i18n="vor.step"></button>
          <label class="vor-slider"><span data-speed>1×</span><input type="range" data-speed-range min="0.05" max="1" step="0.05" value="1"></label>
        </div>
      </fieldset>
      <fieldset>
        <legend data-i18n="vor.labels"></legend>
        <label class="vor-check"><input type="checkbox" data-label-lang="en" checked> <span data-i18n="vor.langEn"></span></label>
        <label class="vor-check"><input type="checkbox" data-label-lang="ko" checked> <span data-i18n="vor.langKo"></span></label>
      </fieldset>
    </div>
  `;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}
