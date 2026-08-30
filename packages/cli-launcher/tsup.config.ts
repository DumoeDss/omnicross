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
  // Optional native code must stay runtime-loaded. Bundling node-pty embeds its
  // ESM-only import.meta shim into the CJS chunk and makes require() unparsable.
  external: ['node-pty'],
  // Keep both formats self-contained. Shared CJS chunks preserve import.meta
  // syntax and become unparsable; the only duplicated entry module is the
  // stateless PTY adapter, while the ProcessSupervisor singleton stays in index.
  splitting: false,
});
