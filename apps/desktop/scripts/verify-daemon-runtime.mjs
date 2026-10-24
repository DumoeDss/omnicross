/**
 * Release gate for the staged daemon runtime.
 *
 * Rejects unreviewed development assets, checks that the target-specific Sharp
 * addon is present and node-pty remains omitted, verifies the private Node
 * binary can load Sharp, and enforces a path-length ceiling (NSIS/makensis
 * cannot open paths past the Windows MAX_PATH cliff — the 0.7.1 bundle failure)
 * before Tauri packages the directory into an installer.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertPrunedDaemonRuntime } from './prune-daemon-runtime.mjs';
import {
  currentSharpRuntimeTarget,
  resolveSharpRuntimeNativePackageNames,
  resolveSharpRuntimePackageNames,
} from './sharp-runtime-packages.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const staging = resolve(here, '..', 'src-tauri', 'daemon-runtime');

assertPrunedDaemonRuntime(staging);
console.info('[daemon-runtime] verified no unreviewed development assets remain');

// Path-length ceiling. makensis opens files through non-long-path-aware APIs,
// so anything past the Windows MAX_PATH cliff fails the NSIS bundle with
// "File: failed opening file" — the 0.7.1 build failure, where the chatgpt-web
// private-runtime closure carried jsdom files up to 261 chars. 250 leaves
// headroom below the cliff while staying far above every legitimate layout.
const MAX_RUNTIME_PATH_CHARS = 250;
let longestRuntimePath = { length: 0, path: staging };
(function walkRuntimePaths(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (path.length > longestRuntimePath.length) longestRuntimePath = { length: path.length, path };
    if (entry.isDirectory()) walkRuntimePaths(path);
  }
})(staging);
if (longestRuntimePath.length > MAX_RUNTIME_PATH_CHARS) {
  throw new Error(
    `staged runtime path is ${longestRuntimePath.length} chars (>${MAX_RUNTIME_PATH_CHARS}): ` +
    `${longestRuntimePath.path}\nNSIS cannot package paths past the Windows MAX_PATH cliff. ` +
    'Review scripts/prune-daemon-runtime.mjs (REDUNDANT_RUNTIME_PACKAGES) before packaging.',
  );
}
console.info(
  `[daemon-runtime] verified runtime paths stay under ${MAX_RUNTIME_PATH_CHARS} chars (longest ${longestRuntimePath.length})`,
);

function containsNativeAddon(directory) {
  if (!existsSync(directory)) return false;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && containsNativeAddon(path)) return true;
    if (entry.isFile() && entry.name.endsWith('.node')) return true;
  }
  return false;
}

const sharpManifestPath = join(staging, 'node_modules', 'sharp', 'package.json');
if (!existsSync(sharpManifestPath)) {
  throw new Error(`staged Sharp manifest missing: ${sharpManifestPath}`);
}
JSON.parse(readFileSync(sharpManifestPath, 'utf8'));

const target = currentSharpRuntimeTarget();
for (const packageName of resolveSharpRuntimePackageNames(target)) {
  const packageDir = join(staging, 'node_modules', ...packageName.split('/'));
  if (!existsSync(join(packageDir, 'package.json'))) {
    throw new Error(`staged Sharp runtime package missing: ${packageDir}`);
  }
}
for (const packageName of resolveSharpRuntimeNativePackageNames(target)) {
  const packageDir = join(staging, 'node_modules', ...packageName.split('/'));
  if (!containsNativeAddon(packageDir)) {
    throw new Error(`staged Sharp native addon missing from ${packageDir}`);
  }
}

const nodePtyDir = join(staging, 'node_modules', 'node-pty');
if (existsSync(nodePtyDir)) {
  throw new Error(`node-pty must remain omitted from the staged daemon runtime: ${nodePtyDir}`);
}

const bundledNode = join(staging, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
if (!existsSync(bundledNode)) throw new Error(`bundled Node runtime missing: ${bundledNode}`);

const sharpEntry = pathToFileURL(join(staging, 'node_modules', 'sharp', 'dist', 'sharp.mjs')).href;
execFileSync(
  bundledNode,
  ['--no-warnings', '--input-type=module', '-e', `await import(${JSON.stringify(sharpEntry)})`],
  { cwd: staging, stdio: 'inherit' },
);

console.info('[daemon-runtime] verified bundled Node can load the target Sharp native addon');

// Dedupe proof: when the chatgpt-web private runtime is staged, its nested
// jsdom copy is pruned (see REDUNDANT_RUNTIME_PACKAGES) in favor of the
// identical version at the runtime root. The bundled Node must still resolve
// jsdom FROM the chatgpt-web package to that root copy — proving the walk-up
// the prune relies on actually works on the shipped runtime.
const chatgptWebRuntime = join(
  staging,
  'node_modules', '@omnicross', 'daemon', 'node_modules', '@omnicross', 'chatgpt-web',
);
if (existsSync(chatgptWebRuntime)) {
  const runtimeRootJsdom = join(staging, 'node_modules', 'jsdom');
  const probe = [
    "const from = process.argv[1];",
    "const expectedRoot = process.argv[2];",
    "const { createRequire } = require('node:module');",
    "const resolved = createRequire(require('node:path').join(from, 'package.json')).resolve('jsdom/package.json');",
    "if (!resolved.startsWith(expectedRoot + require('node:path').sep)) {",
    "  throw new Error(`jsdom resolved outside the runtime root: ${resolved}`);",
    "}",
  ].join('\n');
  execFileSync(
    bundledNode,
    ['--no-warnings', '-e', probe, chatgptWebRuntime, runtimeRootJsdom],
    { cwd: staging, stdio: 'inherit' },
  );
  console.info('[daemon-runtime] verified chatgpt-web resolves the runtime-root jsdom');
}
