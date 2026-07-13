import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Frontend lives in web/. In dev, Vite serves the UI on :5173 and proxies API +
// WebSocket traffic to the Node server on :4280. In prod, `vite build` emits
// web/dist which the Node server serves directly.
export default defineConfig({
  root: 'web',
  plugins: [
    svelte({
      // This is a local, single-user desktop-style tool driven by keyboard +
      // mouse; the Svelte a11y lints for click-handlers-on-divs (modal
      // backdrops, list rows) aren't relevant here, so keep the build clean.
      onwarn(warning, handler) {
        if (warning.code?.startsWith('a11y')) return;
        handler?.(warning);
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:4280',
      '/ws': { target: 'ws://127.0.0.1:4280', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
