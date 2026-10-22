import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// In docker-compose.dev.yml the API is reachable as http://api:8080.
const apiTarget = process.env.VITE_API_PROXY ?? 'http://api:8080';

// OCR runs fully self-hosted (CSP 'self', no third-party downloads): the tesseract.js worker, its
// LSTM wasm cores and the bundled language data are copied to /tesseract/ in the build.
export const OCR_LANGS = ['eng', 'bos', 'hrv'];
function tesseractAssets(): Plugin {
  const req = createRequire(import.meta.url);
  const tess = dirname(req.resolve('tesseract.js/package.json'));
  const core = dirname(
    createRequire(join(tess, 'package.json')).resolve('tesseract.js-core/package.json'),
  );
  return {
    name: 'finplat-tesseract-assets',
    apply: 'build',
    writeBundle(o) {
      const out = join(o.dir ?? 'dist', 'tesseract');
      mkdirSync(join(out, 'lang'), { recursive: true });
      cpSync(join(tess, 'dist/worker.min.js'), join(out, 'worker.min.js'));
      for (const f of readdirSync(core))
        if (/^tesseract-core.*lstm\.wasm(\.js)?$/.test(f)) cpSync(join(core, f), join(out, f));
      for (const l of OCR_LANGS) {
        const dir = dirname(req.resolve(`@tesseract.js-data/${l}/package.json`));
        cpSync(
          join(dir, `4.0.0_best_int/${l}.traineddata.gz`),
          join(out, `lang/${l}.traineddata.gz`),
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tesseractAssets(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt', // the user decides when to reload into a new version
      injectRegister: false, // registered from src/shell/UpdatePrompt.tsx
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Finance Platform',
        short_name: 'Finance',
        description: 'Local-first personal finance and expense management',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#0d1117',
        theme_color: '#1f6feb',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // App shell only. API, MCP and anything with credentials is never cached (PLAN §37).
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        globIgnores: ['tesseract/**'], // OCR assets (~20 MB) load on first use, not precached
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/mcp/, /^\/oauth\//, /^\/\.well-known\//],
        runtimeCaching: [],
        importScripts: ['push-sw.js'], // Web Push + notificationclick handlers (public/push-sw.js)
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    allowedHosts: true,
    proxy: {
      '/api': apiTarget,
      '/mcp': apiTarget,
      '/oauth': apiTarget,
      '/.well-known/oauth-': apiTarget,
    },
  },
  build: { sourcemap: true, chunkSizeWarningLimit: 2000 },
  // The import parser worker (features/import/parse.worker.ts) lazy-loads pdfjs: needs ES workers.
  worker: { format: 'es' },
});
