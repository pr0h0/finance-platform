import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In docker-compose.dev.yml the API is reachable as http://api:8080.
const apiTarget = process.env.VITE_API_PROXY ?? 'http://api:8080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    allowedHosts: true,
    proxy: { '/api': apiTarget, '/mcp': apiTarget },
  },
  build: { sourcemap: true },
});
