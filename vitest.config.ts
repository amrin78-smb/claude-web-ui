import { defineConfig } from 'vitest/config';

// Dedicated Vitest config for the server/* test suite. Vitest ignores
// vite.config.mts entirely whenever a vitest.config.* file is present (it
// does not merge/inherit), so this file must stay self-contained: no
// `root: 'web'`, no Svelte plugin. Keeping it separate lets the frontend's
// vite.config.mts stay untouched for `vite build` / `vite dev`.
export default defineConfig({
  test: {
    include: ['server/**/*.test.js'],
    // The server/*.test.js files are CommonJS and expect describe/it/expect/vi
    // etc. as ambient globals (Vitest 4's package export map throws if you
    // `require('vitest')` directly — ESM-only). `globals: true` injects them
    // without needing an import.
    globals: true,
  },
});
