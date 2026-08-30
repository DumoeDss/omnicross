/**
 * Release gate for the staged daemon runtime.
 *
 * Checks that the target-specific Sharp addon is present, node-pty remains
 * omitted, and the private Node binary can actually load Sharp before Tauri
 * packages the directory into an installer.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  currentSharpRuntimeTarget,
  resolveSharpRuntimeNativePackageNames,
  resolveSharpRuntimePackageNames,
} from './sharp-runtime-packages.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const staging = resolve(here, '..', 'src-tauri', 'daemon-runtime');

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
