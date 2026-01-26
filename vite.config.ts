import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src/web',
  base: './',
  publicDir: '../../public',
  plugins: [],
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/web/index.html'),
        tools: resolve(__dirname, 'src/web/tools/index.html'),
        splitter: resolve(__dirname, 'src/web/tools/splitter.html'),
        planner: resolve(__dirname, 'src/web/tools/planner.html'),
        enrich: resolve(__dirname, 'src/web/tools/enrich.html'),
        compare: resolve(__dirname, 'src/web/tools/compare.html'),
        daylight: resolve(__dirname, 'src/web/tools/daylight.html'),
        combiner: resolve(__dirname, 'src/web/tools/combiner.html'),
        optimizer: resolve(__dirname, 'src/web/tools/optimizer.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@lib': resolve(__dirname, 'src/lib'),
    },
  },
});
