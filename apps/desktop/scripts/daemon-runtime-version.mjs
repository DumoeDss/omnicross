#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PUBLISHABLE_WORKSPACES,
  assertReleaseVersion,
  normalizeStableVersion,
} from '../../../scripts/release-version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, '..', '..', '..');
const defaultStaging = resolve(here, '..', 'src-tauri', 'daemon-runtime');
const dependencySections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const internalPackageNames = new Set(PUBLISHABLE_WORKSPACES.map(({ name }) => name));

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function assertRepositoryReleaseVersion({ root = defaultRoot } = {}) {
  const targetRoot = resolve(root);
  const version = normalizeStableVersion(readJson(join(targetRoot, 'package.json')).version);
  assertReleaseVersion({ root: targetRoot, version });
  return version;
}

export function assertDaemonRuntimeVersion({
  root = defaultRoot,
  staging = defaultStaging,
} = {}) {
  const version = assertRepositoryReleaseVersion({ root });
  const targetStaging = resolve(staging);
  const errors = [];

  for (const { name, path } of PUBLISHABLE_WORKSPACES) {
    const manifestPath = join(targetStaging, 'node_modules', ...name.split('/'), 'package.json');
    let manifest;
    try {
      manifest = readJson(manifestPath);
    } catch (error) {
      errors.push(`staged ${name} manifest cannot be read at ${manifestPath}: ${error.message}`);
      continue;
    }
    if (manifest.name !== name) {
      errors.push(`staged ${name} package name is ${JSON.stringify(manifest.name)}; expected ${name}`);
    }
    if (manifest.version !== version) {
      errors.push(`staged ${name} version is ${JSON.stringify(manifest.version)}; expected ${version}`);
    }

    const sourceManifest = readJson(join(resolve(root), path, 'package.json'));
    for (const section of dependencySections) {
      const sourceRanges = sourceManifest[section] ?? {};
      const stagedRanges = manifest[section] ?? {};
      const names = new Set([
        ...Object.keys(sourceRanges).filter((dependency) => internalPackageNames.has(dependency)),
        ...Object.keys(stagedRanges).filter((dependency) => internalPackageNames.has(dependency)),
      ]);
      for (const dependency of names) {
        if (stagedRanges[dependency] !== sourceRanges[dependency]) {
          errors.push(
            `staged ${name} ${section} ${dependency} range is ${stagedRanges[dependency] ?? '<missing>'}; ` +
            `expected ${sourceRanges[dependency] ?? '<missing>'}`,
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Staged daemon runtime does not match release ${version}:\n- ${errors.join('\n- ')}`);
  }
  return version;
}

export function runCli(args = process.argv.slice(2)) {
  const [mode, ...extra] = args;
  if ((mode !== undefined && mode !== '--source') || extra.length > 0) {
    throw new Error('Usage: node scripts/daemon-runtime-version.mjs [--source]');
  }
  return mode === '--source'
    ? { scope: 'Repository release', version: assertRepositoryReleaseVersion() }
    : { scope: 'Staged daemon runtime', version: assertDaemonRuntimeVersion() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { scope, version } = runCli();
    process.stdout.write(`${scope} matches release ${version}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
