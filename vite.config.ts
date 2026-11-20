import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  base: '/ent-3d/',
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
