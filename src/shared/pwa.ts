import { t } from './i18n';

function showUpdateToast(): void {
  if (document.querySelector('.update-toast')) return;
  const toast = document.createElement('div');
  toast.className = 'update-toast';
  toast.innerHTML = `<p></p><button type="button"></button>`;
  const text = toast.querySelector('p');
  const button = toast.querySelector('button');
  if (text) text.textContent = t('update.title');
  if (button) {
    button.textContent = t('update.reload');
    button.addEventListener('click', () => window.location.reload());
  }
  document.body.append(toast);
}

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) showUpdateToast();
    });
    const base = import.meta.env.BASE_URL;
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {
      /* offline or unsupported scope; the page still works */
    });
  });
}
