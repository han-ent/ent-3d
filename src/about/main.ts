import '../styles/app.css';
import { installFonts } from '../shared/fonts';
import { applyI18n, initI18n, onLangChange, t, text } from '../shared/i18n';
import { fetchJson, publicUrl } from '../shared/paths';
import { registerServiceWorker } from '../shared/pwa';
import type { Manifest } from '../shared/types';
import { mountShell } from '../shared/ui/chrome';

installFonts();
initI18n();
registerServiceWorker();

const { main } = mountShell('about');
main.innerHTML = `
  <article class="prose">
    <h1 data-i18n="about.title"></h1>
    <p data-i18n="about.lead"></p>
    <h2 data-i18n="about.openearTitle"></h2>
    <p data-i18n="about.openearBody"></p>
    <p>
      <a href="https://www.nature.com/articles/sdata2018297">Sieber et al., Scientific Data 2018</a><br />
      <a href="https://zenodo.org/records/1473724">Zenodo 1473724</a><br />
      <a href="https://creativecommons.org/licenses/by/4.0/">Creative Commons Attribution 4.0</a>
    </p>
    <h2 data-i18n="about.obligationsTitle"></h2>
    <ul>
      <li data-i18n="about.obligation1"></li>
      <li data-i18n="about.obligation2"></li>
      <li data-i18n="about.obligation3"></li>
    </ul>
    <h2 data-i18n="about.sampleTitle"></h2>
    <p data-i18n="about.sampleBody"></p>
    <h2 data-i18n="about.upperTitle"></h2>
    <p data-i18n="about.upperBody"></p>
    <p><a href="https://github.com/LluisV/Z-Anatomy">Z-Anatomy</a> · <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a></p>
    <p><a href="https://github.com/makehumancommunity/makehuman/blob/master/makehuman/data/3dobjs/base.obj">MakeHuman hm08 base mesh</a> · <a href="https://creativecommons.org/publicdomain/zero/1.0/">CC0 1.0</a></p>
    <h2 data-i18n="about.vorTitle"></h2>
    <p data-i18n="about.vorBody"></p>
    <h2 data-i18n="about.reviewTitle"></h2>
    <p data-i18n="about.reviewBody"></p>
    <p data-i18n="about.jugular"></p>
    <h2 data-i18n="about.coordsTitle"></h2>
    <div id="about-coords"></div>
    <p class="credit"><span data-i18n="footer.blurb"></span></p>
    <p class="credit"><a href="${publicUrl('fonts/OFL.txt')}">Pretendard, SIL Open Font License 1.1</a></p>
  </article>
`;

const coords = main.querySelector<HTMLElement>('#about-coords')!;
let loaded: Manifest | null = null;

function paintCoords(): void {
  if (!loaded) {
    coords.replaceChildren();
    return;
  }
  const offset = loaded.viewer_offset_mm.map((value) => value.toFixed(2)).join(', ');
  coords.innerHTML = `
    <p>${text(loaded.coordinate_system.note)}</p>
    <p>${t('common.version')} ${loaded.model_version}</p>
    <p>viewer_offset_mm ${offset}</p>
  `;
}

const paint = () => {
  document.title = `${t('about.title')} · ENT 3D`;
  applyI18n(main);
  paintCoords();
};
onLangChange(paint);
paint();

fetchJson<Manifest>(publicUrl('temporal-bone/manifest.json'))
  .then((manifest) => {
    loaded = manifest;
    paintCoords();
  })
  .catch(() => {
    coords.textContent = '';
  });
