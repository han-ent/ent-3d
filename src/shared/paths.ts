/** URL for a file in `public/`, respecting the Vite base (`/ent-3d/`). */
export function publicUrl(path: string): string {
  const base = import.meta.env.BASE_URL;
  const trimmed = path.replace(/^\//, '');
  return `${base}${trimmed}`;
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
