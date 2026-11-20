import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../src/shared/i18n/en.json';
import ko from '../src/shared/i18n/ko.json';

const root = resolve(import.meta.dirname, '..');

describe('project policy', () => {
  it('keeps Korean and English UI keys in parallel', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ko).sort());
    expect(ko['info.function']).toBe('기능적 역할');
    expect(ko['info.summary']).toBe('해부');
  });

  it('bundles the Draco decoder locally', () => {
    const viewer = readFileSync(resolve(root, 'src/shared/viewer/Viewer.ts'), 'utf8');
    expect(viewer).toContain("publicUrl('draco/')");
    expect(viewer).not.toMatch(/https?:\/\//);
    expect(existsSync(resolve(root, 'public/draco/draco_decoder.wasm'))).toBe(true);
    expect(existsSync(resolve(root, 'public/draco/draco_wasm_wrapper.js'))).toBe(true);
  });

  it('versions the asset cache and prefers the network for json', () => {
    const source = readFileSync(resolve(root, 'public/sw.js'), 'utf8');
    expect(source).toContain('__ENT3D_BUILD__');
    expect(source).toContain('ent-3d-');
    expect(source).toMatch(/skipWaiting/);
    expect(source).toMatch(/clients\.claim/);
    expect(source).toMatch(/caches\.delete/);
    const fetchBody = source.slice(source.indexOf("addEventListener('fetch'"));
    expect(fetchBody).toMatch(/JSON_FILE/);
    expect(fetchBody).toMatch(/HEAVY/);
    expect(fetchBody.indexOf('networkFirst')).toBeLessThan(fetchBody.indexOf('cacheFirst'));
    expect(source).toMatch(/glb/);
    expect(source).not.toContain('ent-3d-assets-v3');
  });

  it('self-hosts Pretendard under the SIL Open Font License', () => {
    const license = readFileSync(resolve(root, 'public/fonts/OFL.txt'), 'utf8');
    const fonts = readFileSync(resolve(root, 'src/shared/fonts.ts'), 'utf8');
    expect(license).toMatch(/SIL OPEN FONT LICENSE/);
    expect(fonts).toMatch(/font-display:\s*swap/);
    expect(fonts).toMatch(/Pretendard-Regular\.woff2/);
    expect(fonts).toMatch(/Pretendard-SemiBold\.woff2/);
    expect(existsSync(resolve(root, 'public/fonts/Pretendard-Regular.woff2'))).toBe(true);
    expect(existsSync(resolve(root, 'public/fonts/Pretendard-SemiBold.woff2'))).toBe(true);
  });

  it('scopes the PWA at the site base', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.webmanifest'), 'utf8')) as {
      start_url: string;
      scope: string;
      lang: string;
    };
    expect(manifest.scope).toBe('./');
    expect(manifest.start_url).toBe('./temporal-bone/');
    expect(manifest.lang).toBe('ko');
  });

  it('deploys GitHub Pages from the Vite build on main', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/pages.yml'), 'utf8');
    const vite = readFileSync(resolve(root, 'vite.config.ts'), 'utf8');
    expect(workflow).toMatch(/workflow_dispatch/);
    expect(workflow).toMatch(/push:[\s\S]*branches:[\s\S]*-\s*main/);
    expect(workflow).not.toMatch(/if:\s*\$\{\{\s*false\s*\}\}/);
    expect(workflow).toMatch(/actions\/configure-pages@v/);
    expect(workflow).toMatch(/actions\/upload-pages-artifact@v/);
    expect(workflow).toMatch(/actions\/deploy-pages@v/);
    expect(workflow).toMatch(/pages:\s*write/);
    expect(workflow).toMatch(/id-token:\s*write/);
    expect(workflow).toMatch(/cancel-in-progress:\s*false/);
    expect(workflow).toMatch(/npm ci && npm run build/);
    expect(workflow).toMatch(/path:\s*dist/);
    expect(vite).toMatch(/base:\s*'\/ent-3d\/'/);
  });
});
