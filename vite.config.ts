import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

function buildId(): string {
  try {
    const sha = execSync('git rev-parse --short=12 HEAD', { cwd: root, encoding: 'utf8' }).trim();
    return sha || 'dev';
  } catch {
    return 'dev';
  }
}

const ENT3D_BUILD = buildId();

function stampServiceWorker(): Plugin {
  return {
    name: 'ent3d-sw-build',
    apply: 'build',
    closeBundle() {
      const file = resolve(root, 'dist/sw.js');
      const text = readFileSync(file, 'utf8').replaceAll('__ENT3D_BUILD__', ENT3D_BUILD);
      writeFileSync(file, text);
    },
  };
}

export default defineConfig({
  base: '/ent-3d/',
  define: {
    __ENT3D_BUILD__: JSON.stringify(ENT3D_BUILD),
  },
  plugins: [stampServiceWorker()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        temporalBone: resolve(root, 'temporal-bone/index.html'),
        vor: resolve(root, 'vor/index.html'),
        about: resolve(root, 'about/index.html'),
      },
    },
  },
  server: { host: '0.0.0.0', port: 5173 },
  preview: { host: '0.0.0.0', port: 4173 },
});
