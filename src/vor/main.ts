import '../styles/app.css';
import { installFonts } from '../shared/fonts';
import { applyI18n, initI18n, onLangChange, t } from '../shared/i18n';
import { pageUrl } from '../shared/paths';
import { registerServiceWorker } from '../shared/pwa';
import { mountShell } from '../shared/ui/chrome';

installFonts();
initI18n();
registerServiceWorker();

const { main } = mountShell('vor');
main.innerHTML = `
  <article class="prose">
    <p class="kicker" data-i18n="vor.preparing"></p>
    <h1 data-i18n="vor.title"></h1>
    <p data-i18n="vor.body"></p>
    <p><a class="enter" href="${pageUrl('temporal-bone')}" data-i18n="home.enter"></a></p>
    <p data-i18n="vor.licenceNote"></p>
  </article>
`;

const paint = () => {
  document.title = `${t('vor.title')} · ENT 3D`;
  applyI18n(main);
};
onLangChange(paint);
paint();
