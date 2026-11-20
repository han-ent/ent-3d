import './styles/app.css';
import { installFonts } from './shared/fonts';
import { applyI18n, initI18n, onLangChange } from './shared/i18n';
import { pageUrl } from './shared/paths';
import { registerServiceWorker } from './shared/pwa';
import { mountShell } from './shared/ui/chrome';

installFonts();
initI18n();
registerServiceWorker();

const { main } = mountShell('home');
main.innerHTML = `
  <section class="hero">
    <p class="kicker">ENT 3D</p>
    <h1 data-i18n="nav.temporal"></h1>
    <p data-i18n="home.lead"></p>
    <a class="enter" href="${pageUrl('temporal-bone')}" data-i18n="home.enter"></a>
  </section>
  <p class="credit">
    <span data-i18n="footer.blurb"></span>
    · <a href="${pageUrl('about')}" data-i18n="nav.about"></a>
  </p>
`;

const paint = () => applyI18n(main);
onLangChange(paint);
paint();
