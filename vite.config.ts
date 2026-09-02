import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'src/web',
  base: './',
  publicDir: '../../public',
  plugins: [],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'src/web/index.html'),
        tools: resolve(import.meta.dirname, 'src/web/tools/index.html'),
        splitter: resolve(import.meta.dirname, 'src/web/tools/splitter.html'),
        planner: resolve(import.meta.dirname, 'src/web/tools/planner.html'),
        enrich: resolve(import.meta.dirname, 'src/web/tools/enrich.html'),
        compare: resolve(import.meta.dirname, 'src/web/tools/compare.html'),
        daylight: resolve(import.meta.dirname, 'src/web/tools/daylight.html'),
        combiner: resolve(import.meta.dirname, 'src/web/tools/combiner.html'),
        optimizer: resolve(import.meta.dirname, 'src/web/tools/optimizer.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@lib': resolve(import.meta.dirname, 'src/lib'),
    },
  },
});
