import { defineConfig } from 'tsup';

// @omnicross/subscriptions is consumed via the barrel (.) and the `oauth` subpath
// (a directory module). Entry KEY = consumer subpath → dist/<key>.{js,cjs,d.ts},
// resolved by the "./*" exports wildcard.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    oauth: 'src/oauth/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: false,
  clean: true,
  // ESM splitting shares internal modules across entries so module-level
  // singletons (account-service / registry slots) stay single-instance.
  // CJS keeps per-entry inlining (esbuild limitation; ESM-only consumers).
  splitting: true,
});
