import { defineConfig } from 'tsup';

// @omnicross/cli-launcher is consumed via the barrel (.) plus the host-facing
// subpaths (pty-adapter / types — deep-imported by embedding hosts), all
// resolved through the package.json "./*" exports wildcard onto dist/<key>.js.
// node-pty is a dependency (externalized).
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'pty-adapter': 'src/pty-adapter.ts',
    types: 'src/types.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: false,
  clean: true,
  // ESM splitting shares internal modules across entries so module-level
  // singletons (the ProcessSupervisor instance) stay single-instance.
  // CJS keeps per-entry inlining (esbuild limitation; ESM-only consumers).
  splitting: true,
});
