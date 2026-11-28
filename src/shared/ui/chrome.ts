import { applyI18n, getLang, onLangChange, setLang, t } from '../i18n';
import { pageUrl } from '../paths';

export type NavId = 'home' | 'temporal' | 'vor' | 'about';

/** Same destinations as the desktop header, in that order. */
export function headerLinks(): { id: NavId; key: string; href: string }[] {
  return [
    { id: 'home', key: 'nav.home', href: pageUrl('') },
    { id: 'temporal', key: 'nav.temporal', href: pageUrl('temporal-bone') },
    { id: 'vor', key: 'nav.vor', href: pageUrl('vor') },
    { id: 'about', key: 'nav.about', href: pageUrl('about') },
  ];
}

export function renderHeader(active: NavId): HTMLElement {
  const header = document.createElement('header');
  header.className = 'topbar';
  const links = headerLinks();
  const nav = links
    .map(
      (link) =>
        `<a class="nav-link${link.id === active ? ' is-active' : ''}" href="${link.href}" data-i18n="${link.key}"></a>`,
    )
    .join('');
  header.innerHTML = `
    <a class="brand" href="${pageUrl('')}">ENT 3D</a>
    <nav class="nav">${nav}</nav>
    <button type="button" class="lang-btn" data-lang-toggle></button>
  `;
  const toggle = header.querySelector<HTMLButtonElement>('[data-lang-toggle]')!;
  const paint = () => {
    toggle.textContent = getLang() === 'ko' ? t('lang.en') : t('lang.ko');
    toggle.setAttribute('aria-label', getLang() === 'ko' ? 'English' : '한국어');
    applyI18n(header);
  };
  toggle.addEventListener('click', () => setLang(getLang() === 'ko' ? 'en' : 'ko'));
  onLangChange(paint);
  paint();
  return header;
}

export function renderFooter(): HTMLElement {
  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  footer.innerHTML = `
    <p>
      <span data-i18n="footer.blurb"></span>
      <span data-i18n="footer.sample"></span>
    </p>
    <p class="footer-links">
      <a href="https://www.nature.com/articles/sdata2018297">Scientific Data 2018</a>
      <a href="https://zenodo.org/records/1473724">Zenodo</a>
      <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>
      <a href="${pageUrl('about')}" data-i18n="footer.about"></a>
    </p>
  `;
  const paint = () => applyI18n(footer);
  onLangChange(paint);
  paint();
  return footer;
}

export function mountShell(active: NavId): { header: HTMLElement; main: HTMLElement } {
  const header = renderHeader(active);
  const main = document.createElement('main');
  main.className = 'page';
  document.body.classList.add('page-body');
  document.body.replaceChildren(header, main);
  return { header, main };
}
