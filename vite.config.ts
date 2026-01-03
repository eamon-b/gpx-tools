import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readdirSync, existsSync, statSync } from 'fs';

// Dynamically find all trail page directories
function getTrailInputs(): Record<string, string> {
  const trailsDir = resolve(__dirname, 'src/web/trails');
  const inputs: Record<string, string> = {};

  if (!existsSync(trailsDir)) return inputs;

  const entries = readdirSync(trailsDir);
  for (const entry of entries) {
    const entryPath = resolve(trailsDir, entry);
    if (statSync(entryPath).isDirectory()) {
      const indexPath = resolve(entryPath, 'index.html');
      if (existsSync(indexPath)) {
        inputs[`trail-${entry}`] = indexPath;
      }
    }
  }

  return inputs;
}

export default defineConfig({
  root: 'src/web',
  base: './',
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
        trails: resolve(__dirname, 'src/web/trails/index.html'),
        // Dynamically include all generated trail pages
        ...getTrailInputs(),
      },
    },
  },
  resolve: {
    alias: {
      '@lib': resolve(__dirname, 'src/lib'),
    },
  },
});
