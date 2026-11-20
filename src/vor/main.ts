import '../styles/app.css';
import { applyI18n, initI18n, onLangChange, t } from '../shared/i18n';
import { registerServiceWorker } from '../shared/pwa';
import { mountShell } from '../shared/ui/chrome';

initI18n();
registerServiceWorker();

const { main } = mountShell('vor');
main.innerHTML = `
  <article class="prose">
    <h1 data-i18n="vor.title"></h1>
    <p data-i18n="vor.body"></p>
    <p data-i18n="vor.licenceNote"></p>
  </article>
`;

const paint = () => {
  document.title = `${t('vor.title')} · ENT 3D`;
  applyI18n(main);
};
onLangChange(paint);
paint();
