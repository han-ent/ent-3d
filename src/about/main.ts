import '../styles/app.css';
import { applyI18n, initI18n, onLangChange, t } from '../shared/i18n';
import { registerServiceWorker } from '../shared/pwa';
import { mountShell } from '../shared/ui/chrome';

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
    <h2 data-i18n="about.vorTitle"></h2>
    <p data-i18n="about.vorBody"></p>
    <h2 data-i18n="about.reviewTitle"></h2>
    <p data-i18n="about.reviewBody"></p>
  </article>
`;

const paint = () => {
  document.title = `${t('about.title')} · ENT 3D`;
  applyI18n(main);
};
onLangChange(paint);
paint();
