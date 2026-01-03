import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readdirSync, existsSync, statSync, readFileSync } from 'fs';

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
  server: {
    fs: {
      // Allow serving files from the data directory
      allow: ['../..'],
    },
  },
  plugins: [
    {
      name: 'serve-data-directory',
      configureServer(server) {
        // Serve /data/* from the project root data/ directory in dev
        server.middlewares.use('/data', (req, res, next) => {
          const filePath = resolve(__dirname, 'data', (req.url || '').replace(/^\//, ''));
          if (existsSync(filePath) && statSync(filePath).isFile()) {
            const content = readFileSync(filePath);
            const ext = filePath.split('.').pop();
            const mimeTypes: Record<string, string> = {
              json: 'application/json',
              gpx: 'application/gpx+xml',
              csv: 'text/csv',
            };
            res.setHeader('Content-Type', mimeTypes[ext || ''] || 'application/octet-stream');
            res.end(content);
          } else {
            next();
          }
        });
      },
    },
  ],
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
