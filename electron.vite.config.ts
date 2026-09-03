import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const aliases = {
  '@core': resolve('src/core'),
  '@shared': resolve('src/shared'),
  '@renderer': resolve('src/renderer/src'),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: aliases },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: aliases },
    build: { lib: { entry: resolve('src/preload/index.ts'), formats: ['cjs'] } },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: aliases },
    plugins: [react()],
  },
});
