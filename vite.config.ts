import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src/web',
  base: './',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@lib': resolve(__dirname, 'src/lib'),
    },
  },
});
