import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{js,ts}'],
    environment: 'jsdom',
    // gpx-splitter's 12k-point jsdom parse takes ~5 s under parallel load
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@lib': resolve(import.meta.dirname, 'src/lib'),
    },
  },
});
