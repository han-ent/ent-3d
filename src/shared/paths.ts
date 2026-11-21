import { BUILD_ID } from './build';

/** URL for a file in `public/`, respecting the Vite base (`/ent-3d/`). */
export function publicUrl(path: string): string {
  const base = import.meta.env.BASE_URL;
  const trimmed = path.replace(/^\//, '');
  return `${base}${trimmed}`;
}

/**
 * glb and webp URLs carry the build id so a cache-first service worker
 * cannot keep serving the previous mesh or slice after a deploy.
 */
export function assetUrl(path: string): string {
  const url = publicUrl(path);
  if (!/\.(?:glb|gltf|webp|woff2)$/i.test(path.split('?')[0] ?? path)) return url;
  const join = url.includes('?') ? '&' : '?';
  return `${url}${join}v=${BUILD_ID}`;
}

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return (await response.json()) as T;
}

export function pageUrl(page: '' | 'temporal-bone' | 'vor' | 'about'): string {
  const base = import.meta.env.BASE_URL;
  return page === '' ? base : `${base}${page}/`;
}
