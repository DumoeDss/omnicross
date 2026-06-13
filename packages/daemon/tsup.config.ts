import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// @omnicross/daemon ships a library barrel (.) + the `omnicross` CLI bin (cli.ts).
// The CLI shebang comes from `src/cli.ts`'s own `#!/usr/bin/env node` first line,
// which esbuild preserves on the `cli` output. We deliberately DO NOT add a tsup
// `banner` shebang: a global banner is applied to EVERY entry, which (a) duplicated
// the shebang on cli.js (source shebang + banner → `SyntaxError: Invalid or
// unexpected token` on the second `#!`) and (b) wrongly prepended a shebang to the
// library barrel (index.js/.cjs). All @omnicross/* + node deps stay external (the
// daemon is the embedder, not a bundler).
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: false,
  clean: true,
  splitting: false,
  // Identity handshake (desktop-shell adopt-or-restart): bake the package
  // version into the build so the AdminServer can report it on every response.
  define: {
    __DAEMON_VERSION__: JSON.stringify(pkg.version),
  },
});
