import './styles/app.css';
import { applyI18n, initI18n, onLangChange } from './shared/i18n';
import { pageUrl } from './shared/paths';
import { registerServiceWorker } from './shared/pwa';
import { mountShell } from './shared/ui/chrome';

initI18n();
registerServiceWorker();

const { main } = mountShell('home');
main.innerHTML = `
  <section class="hero">
    <h1>ENT 3D</h1>
    <p data-i18n="home.lead"></p>
  </section>
  <div class="cards">
    <a class="card-link" href="${pageUrl('temporal-bone')}">
      <h2 data-i18n="nav.temporal"></h2>
      <p data-i18n="home.temporalBlurb"></p>
      <span data-i18n="home.open"></span>
    </a>
    <a class="card-link" href="${pageUrl('vor')}">
      <h2 data-i18n="nav.vor"></h2>
      <p data-i18n="home.vorBlurb"></p>
      <span data-i18n="home.open"></span>
    </a>
  </div>
`;

const paint = () => applyI18n(main);
onLangChange(paint);
paint();
