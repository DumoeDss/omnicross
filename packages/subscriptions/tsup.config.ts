import { defineConfig } from 'tsup';

// @omnicross/subscriptions is consumed via the barrel (.) and the `oauth` subpath
// (a directory module). Entry KEY = consumer subpath → dist/<key>.{js,cjs,d.ts},
// resolved by the "./*" exports wildcard.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    oauth: 'src/oauth/index.ts',
    // Consumed as a subpath by the daemon preflight (value import of
    // `accountSupportsModel`). A subpath entry must be registered here or the
    // `./*` exports wildcard resolves to a dist file that was never built.
    'scheduler/accountModelMap': 'src/scheduler/accountModelMap.ts',
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
