/**
 * build-daemon-runtime.mjs — stage a self-contained daemon runtime for the
 * desktop bundle.
 *
 * The packaged shell spawns `node <entry> start --config …`, so the installer
 * must carry the daemon's JS + its node_modules (esbuild-style single-file
 * bundling is off the table: cli-launcher depends on node-pty, a NATIVE addon).
 *
 * Strategy: `npm pack` every workspace package into tarballs, then run a real
 * `npm install` in `src-tauri/daemon-runtime/` with `overrides` pinning all
 * @omnicross/* to the local tarballs — third-party deps (jsdom, node-pty, zod,
 * …) resolve from the registry exactly as a published install would. The
 * resulting tree ships as a Tauri resource; the shell resolves
 * `daemon-runtime/node_modules/@omnicross/daemon/dist/cli.js`.
 *
 * Run via `npm run build` in apps/desktop (wired before `tauri build`), or
 * standalone: `node scripts/build-daemon-runtime.mjs`.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const staging = resolve(here, '..', 'src-tauri', 'daemon-runtime');
const tarballDir = join(staging, 'tarballs');

const PACKAGES = ['contracts', 'core', 'subscriptions', 'cli-launcher', 'ui', 'daemon'];

function sh(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'inherit' });
}

// 1. Fresh dists for everything the tarballs will carry.
if (!existsSync(join(repo, 'packages', 'daemon', 'dist', 'cli.js'))) {
  console.info('[daemon-runtime] package dists missing — running root `npm run build`…');
  sh('npm run build', repo);
}

// 2. Pack each workspace package (npm pack respects `files`, runs `prepack`).
rmSync(staging, { recursive: true, force: true });
mkdirSync(tarballDir, { recursive: true });
const tarballs = {};
for (const name of PACKAGES) {
  sh(`npm pack --pack-destination "${tarballDir}" -w @omnicross/${name}`, repo);
}
for (const file of readdirSync(tarballDir)) {
  const m = /^omnicross-([a-z-]+)-\d/.exec(file);
  if (m) tarballs[m[1]] = file;
}
for (const name of PACKAGES) {
  if (!tarballs[name]) throw new Error(`tarball for @omnicross/${name} not found`);
}

// 3. Offline-pin @omnicross/* via overrides; everything else from the registry.
const manifest = {
  name: 'omnicross-daemon-runtime',
  private: true,
  description: 'Staged daemon runtime bundled into the desktop app (generated — do not edit).',
  dependencies: { '@omnicross/daemon': `file:tarballs/${tarballs.daemon}` },
  overrides: Object.fromEntries(
    PACKAGES.filter((n) => n !== 'daemon').map((n) => [
      `@omnicross/${n}`,
      `file:tarballs/${tarballs[n]}`,
    ]),
  ),
};
writeFileSync(join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

// --omit=optional drops node-pty (a native addon): the daemon never loads it —
// pty mode is for embedded-terminal hosts; the shell/CLI launch external
// terminals via plain spawn. Consumers installing @omnicross/cli-launcher
// normally still get node-pty by default (optionalDependencies semantics).
console.info('[daemon-runtime] npm install (production deps, no optional)…');
sh('npm install --omit=dev --omit=optional --no-audit --no-fund --install-links=false', staging);

const entry = join(staging, 'node_modules', '@omnicross', 'daemon', 'dist', 'cli.js');
if (!existsSync(entry)) throw new Error(`staging failed: ${entry} missing`);

// 4. Trim weight the runtime never loads.
rmSync(tarballDir, { recursive: true, force: true });
rmSync(join(staging, 'package-lock.json'), { force: true });

console.info(`[daemon-runtime] staged → ${entry}`);
