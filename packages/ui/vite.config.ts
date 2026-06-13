import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The Control Panel frontend (@omnicross/ui). The `@` alias points at `src`,
// `@shared` at the hand-mirrored daemon-DTO type subset (`src/shared-types`).
// `server.port 1430` + `strictPort` so Tauri's `build.devUrl` is deterministic.
//
// Dev proxy: the daemon deliberately sends NO CORS headers (a token-free
// loopback service must not be reachable cross-origin), so the dev server
// forwards `/admin/*` to it server-side — the browser only ever talks
// same-origin, exactly like the production `/ui` serving. Override the target
// with VITE_DAEMON_PROXY_TARGET when the daemon runs elsewhere.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared-types', import.meta.url)),
    },
  },
  server: {
    port: 1430,
    strictPort: true,
    proxy: {
      '/admin': {
        target: process.env.VITE_DAEMON_PROXY_TARGET || 'http://127.0.0.1:8766',
        changeOrigin: true,
      },
    },
  },
  // Tauri expects a relative-asset build so the WebView can load file:// assets.
  base: './',
  build: {
    target: 'es2021',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
