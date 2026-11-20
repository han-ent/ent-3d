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

  it('caches large assets in the service worker', () => {
    const source = readFileSync(resolve(root, 'public/sw.js'), 'utf8');
    expect(source).toMatch(/glb/);
    expect(source).toMatch(/cacheFirst/);
    expect(source).toContain('ent-3d-assets');
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
