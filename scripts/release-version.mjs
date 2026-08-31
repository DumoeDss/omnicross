#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDir, '..');
const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const PUBLISHABLE_WORKSPACES = [
  { name: '@omnicross/contracts', path: 'packages/contracts' },
  { name: '@omnicross/core', path: 'packages/core' },
  { name: '@omnicross/subscriptions', path: 'packages/subscriptions' },
  { name: '@omnicross/cli-launcher', path: 'packages/cli-launcher' },
  { name: '@omnicross/ui', path: 'packages/ui' },
  { name: '@omnicross/daemon', path: 'packages/daemon' },
];

export const RELEASE_MANIFEST_PATHS = [
  'package.json',
  'apps/desktop/package.json',
  ...PUBLISHABLE_WORKSPACES.map(({ path }) => `${path}/package.json`),
];
export const TAURI_CONFIG_PATH = 'apps/desktop/src-tauri/tauri.conf.json';
export const LOCKFILE_PATH = 'package-lock.json';

const INTERNAL_PACKAGE_NAMES = new Set(PUBLISHABLE_WORKSPACES.map(({ name }) => name));
const LOCK_KEYS = new Map([
  ['package.json', ''],
  ['apps/desktop/package.json', 'apps/desktop'],
  ...PUBLISHABLE_WORKSPACES.map(({ path }) => [`${path}/package.json`, path]),
]);

export function normalizeStableVersion(input) {
  if (typeof input !== 'string') throw new Error('Release version must be stable exact SemVer.');
  const version = input.startsWith('v') ? input.slice(1) : input;
  if (!STABLE_SEMVER.test(version)) {
    throw new Error(`Release version must be stable exact SemVer (received ${JSON.stringify(input)}).`);
  }
  return version;
}

function readJson(root, relativePath) {
  const absolutePath = join(root, relativePath);
  const source = readFileSync(absolutePath, 'utf8');
  return {
    absolutePath,
    data: JSON.parse(source),
    newline: source.includes('\r\n') ? '\r\n' : '\n',
  };
}

function writeJson(record) {
  const serialized = `${JSON.stringify(record.data, null, 2)}\n`;
  writeFileSync(record.absolutePath, serialized.replace(/\n/g, record.newline), 'utf8');
}

function internalRanges(manifest, section) {
  return Object.entries(manifest[section] ?? {}).filter(([name]) => INTERNAL_PACKAGE_NAMES.has(name));
}

function collectReleaseVersionErrors(root, version) {
  const expectedVersion = normalizeStableVersion(version);
  const errors = [];
  const manifests = new Map();

  for (const relativePath of RELEASE_MANIFEST_PATHS) {
    const manifest = readJson(root, relativePath).data;
    manifests.set(relativePath, manifest);
    if (manifest.version !== expectedVersion) {
      errors.push(`${relativePath} version is ${JSON.stringify(manifest.version)}; expected ${expectedVersion}`);
    }
    for (const section of DEPENDENCY_SECTIONS) {
      for (const [name, range] of internalRanges(manifest, section)) {
        if (range !== `^${expectedVersion}`) {
          errors.push(`${relativePath} ${section} ${name} range is ${range}; expected ^${expectedVersion}`);
        }
      }
    }
  }

  for (const { name, path } of PUBLISHABLE_WORKSPACES) {
    const relativePath = `${path}/package.json`;
    const manifest = manifests.get(relativePath);
    if (manifest.name !== name) {
      errors.push(`${relativePath} package name is ${JSON.stringify(manifest.name)}; expected ${name}`);
    }
    if (manifest.private === true) errors.push(`${relativePath} must remain publishable (private must not be true)`);
    if (manifest.publishConfig?.access !== 'public') {
      errors.push(`${relativePath} publishConfig.access must be public`);
    }
  }

  const tauri = readJson(root, TAURI_CONFIG_PATH).data;
  if (tauri.version !== expectedVersion) {
    errors.push(`${TAURI_CONFIG_PATH} version is ${JSON.stringify(tauri.version)}; expected ${expectedVersion}`);
  }

  const lock = readJson(root, LOCKFILE_PATH).data;
  if (lock.version !== expectedVersion) {
    errors.push(`${LOCKFILE_PATH} version is ${JSON.stringify(lock.version)}; expected ${expectedVersion}`);
  }
  for (const [relativePath, lockKey] of LOCK_KEYS) {
    const lockEntry = lock.packages?.[lockKey];
    if (!lockEntry) {
      errors.push(`${LOCKFILE_PATH} is missing workspace entry ${JSON.stringify(lockKey)}`);
      continue;
    }
    if (lockEntry.version !== expectedVersion) {
      errors.push(`${LOCKFILE_PATH} ${JSON.stringify(lockKey)} version is ${JSON.stringify(lockEntry.version)}; expected ${expectedVersion}`);
    }
    const manifest = manifests.get(relativePath);
    for (const section of DEPENDENCY_SECTIONS) {
      const manifestRanges = new Map(internalRanges(manifest, section));
      const lockRanges = new Map(internalRanges(lockEntry, section));
      const names = new Set([...manifestRanges.keys(), ...lockRanges.keys()]);
      for (const name of names) {
        if (lockRanges.get(name) !== manifestRanges.get(name)) {
          errors.push(
            `${LOCKFILE_PATH} ${JSON.stringify(lockKey)} ${section} ${name} is ${JSON.stringify(lockRanges.get(name))}; ` +
            `expected ${JSON.stringify(manifestRanges.get(name))}`,
          );
        }
      }
    }
  }

  return errors;
}

export function assertReleaseVersion({ root = defaultRoot, version }) {
  const expectedVersion = normalizeStableVersion(version);
  const errors = collectReleaseVersionErrors(resolve(root), expectedVersion);
  if (errors.length > 0) {
    throw new Error(`Release version ${expectedVersion} is not synchronized:\n- ${errors.join('\n- ')}`);
  }
  return expectedVersion;
}

export function prepareReleaseVersion({ root = defaultRoot, version }) {
  const targetRoot = resolve(root);
  const expectedVersion = normalizeStableVersion(version);
  const manifestRecords = new Map();

  for (const relativePath of RELEASE_MANIFEST_PATHS) {
    const record = readJson(targetRoot, relativePath);
    record.data.version = expectedVersion;
    for (const section of DEPENDENCY_SECTIONS) {
      for (const [name] of internalRanges(record.data, section)) {
        record.data[section][name] = `^${expectedVersion}`;
      }
    }
    manifestRecords.set(relativePath, record);
  }

  const tauri = readJson(targetRoot, TAURI_CONFIG_PATH);
  tauri.data.version = expectedVersion;

  const lock = readJson(targetRoot, LOCKFILE_PATH);
  lock.data.version = expectedVersion;
  for (const [relativePath, lockKey] of LOCK_KEYS) {
    const lockEntry = lock.data.packages?.[lockKey];
    if (!lockEntry) throw new Error(`${LOCKFILE_PATH} is missing workspace entry ${JSON.stringify(lockKey)}.`);
    const manifest = manifestRecords.get(relativePath).data;
    lockEntry.version = expectedVersion;
    for (const section of DEPENDENCY_SECTIONS) {
      const manifestRanges = new Map(internalRanges(manifest, section));
      const lockRanges = new Map(internalRanges(lockEntry, section));
      for (const name of new Set([...manifestRanges.keys(), ...lockRanges.keys()])) {
        if (manifestRanges.has(name)) {
          lockEntry[section] ??= {};
          lockEntry[section][name] = manifestRanges.get(name);
        } else {
          delete lockEntry[section][name];
        }
      }
    }
  }

  for (const record of manifestRecords.values()) writeJson(record);
  writeJson(tauri);
  writeJson(lock);
  assertReleaseVersion({ root: targetRoot, version: expectedVersion });
  return expectedVersion;
}

export function runCli(args = process.argv.slice(2), root = defaultRoot) {
  const [command, rawVersion, ...extra] = args;
  if (!['prepare', 'check'].includes(command) || !rawVersion || extra.length > 0) {
    throw new Error(
      'Usage: node scripts/release-version.mjs <prepare|check> <X.Y.Z>\n' +
      'Example: npm run release:prepare -- 0.1.15',
    );
  }
  const version = command === 'prepare'
    ? prepareReleaseVersion({ root, version: rawVersion })
    : assertReleaseVersion({ root, version: rawVersion });
  process.stdout.write(`Release version ${version} is synchronized (${command}).\n`);
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
