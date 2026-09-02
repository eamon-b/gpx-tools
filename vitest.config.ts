import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{js,ts}'],
    environment: 'jsdom',
  },
  resolve: {
    alias: {
      '@lib': resolve(import.meta.dirname, 'src/lib'),
    },
  },
});
