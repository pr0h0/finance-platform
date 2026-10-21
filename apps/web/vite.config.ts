import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// In docker-compose.dev.yml the API is reachable as http://api:8080.
const apiTarget = process.env.VITE_API_PROXY ?? 'http://api:8080';

export default defineConfig({
  plugins: [
    react(),
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
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/mcp/],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    allowedHosts: true,
    proxy: { '/api': apiTarget, '/mcp': apiTarget },
  },
  build: { sourcemap: true, chunkSizeWarningLimit: 2000 },
  // The import parser worker (features/import/parse.worker.ts) lazy-loads pdfjs: needs ES workers.
  worker: { format: 'es' },
});
