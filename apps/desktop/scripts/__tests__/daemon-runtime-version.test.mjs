import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  LOCKFILE_PATH,
  PUBLISHABLE_WORKSPACES,
  RELEASE_MANIFEST_PATHS,
  TAURI_CONFIG_PATH,
  prepareReleaseVersion,
} from '../../../../scripts/release-version.mjs';
import { assertDaemonRuntimeVersion } from '../daemon-runtime-version.mjs';

const repo = join(import.meta.dirname, '..', '..', '..', '..');

function copyJson(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function createPackagingFixture() {
  const root = mkdtempSync(join(tmpdir(), 'omnicross-daemon-runtime-version-'));
  for (const relativePath of [
    ...RELEASE_MANIFEST_PATHS,
    TAURI_CONFIG_PATH,
    LOCKFILE_PATH,
  ]) {
    copyJson(join(repo, relativePath), join(root, relativePath));
  }
  prepareReleaseVersion({ root, version: '9.8.7' });

  const staging = join(root, 'apps', 'desktop', 'src-tauri', 'daemon-runtime');
  for (const { name, path } of PUBLISHABLE_WORKSPACES) {
    const packagePath = join(staging, 'node_modules', ...name.split('/'), 'package.json');
    copyJson(join(root, path, 'package.json'), packagePath);
  }
  return { root, staging };
}

test('rejects a staged daemon runtime whose package version differs from the desktop release', () => {
  const { root, staging } = createPackagingFixture();
  const coreManifestPath = join(staging, 'node_modules', '@omnicross', 'core', 'package.json');
  const coreManifest = JSON.parse(readFileSync(coreManifestPath, 'utf8'));
  coreManifest.version = '0.1.10';
  writeFileSync(coreManifestPath, `${JSON.stringify(coreManifest, null, 2)}\n`, 'utf8');

  assert.throws(
    () => assertDaemonRuntimeVersion({ root, staging }),
    /staged @omnicross\/core version is "0\.1\.10"; expected 9\.8\.7/,
  );
});

test('rejects stale internal dependency ranges in the staged daemon runtime', () => {
  const { root, staging } = createPackagingFixture();
  const daemonManifestPath = join(staging, 'node_modules', '@omnicross', 'daemon', 'package.json');
  const daemonManifest = JSON.parse(readFileSync(daemonManifestPath, 'utf8'));
  daemonManifest.dependencies['@omnicross/core'] = '^0.1.10';
  writeFileSync(daemonManifestPath, `${JSON.stringify(daemonManifest, null, 2)}\n`, 'utf8');

  assert.throws(
    () => assertDaemonRuntimeVersion({ root, staging }),
    /staged @omnicross\/daemon dependencies @omnicross\/core range is \^0\.1\.10; expected \^9\.8\.7/,
  );
});

test('gates direct Tauri builds on the staged daemon runtime version', () => {
  const tauri = JSON.parse(
    readFileSync(join(repo, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'),
  );

  assert.match(
    tauri.build.beforeBuildCommand,
    /^node scripts\/daemon-runtime-version\.mjs && /,
  );
});

test('gates daemon staging before and after assembling the runtime', () => {
  const desktop = JSON.parse(
    readFileSync(join(repo, 'apps', 'desktop', 'package.json'), 'utf8'),
  );
  const steps = desktop.scripts['stage-daemon'].split(' && ');

  assert.equal(steps[0], 'node scripts/daemon-runtime-version.mjs --source');
  assert.equal(steps.at(-1), 'node scripts/daemon-runtime-version.mjs');
});
