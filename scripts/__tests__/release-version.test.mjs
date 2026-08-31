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
import { describe, it } from 'node:test';

import {
  LOCKFILE_PATH,
  PUBLISHABLE_WORKSPACES,
  RELEASE_MANIFEST_PATHS,
  TAURI_CONFIG_PATH,
  assertReleaseVersion,
  normalizeStableVersion,
  prepareReleaseVersion,
} from '../release-version.mjs';

const repo = join(import.meta.dirname, '..', '..');

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
}

function copyReleaseFixture() {
  const root = mkdtempSync(join(tmpdir(), 'omnicross-release-version-'));
  for (const relativePath of [
    ...RELEASE_MANIFEST_PATHS,
    TAURI_CONFIG_PATH,
    LOCKFILE_PATH,
  ]) {
    const destination = join(root, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repo, relativePath), destination);
    const source = readFileSync(destination, 'utf8').replace(/\r\n/g, '\n');
    writeFileSync(destination, source.replace(/\n/g, '\r\n'), 'utf8');
  }
  return root;
}

describe('unified release version contract', () => {
  it('accepts stable exact SemVer with an optional v prefix', () => {
    assert.equal(normalizeStableVersion('1.2.3'), '1.2.3');
    assert.equal(normalizeStableVersion('v0.1.15'), '0.1.15');
    for (const invalid of ['01.2.3', 'v1.2', '1.2.3-beta.1', '1.2.3+build', 'latest']) {
      assert.throws(() => normalizeStableVersion(invalid), /stable exact SemVer/);
    }
  });

  it('prepares every product manifest, workspace dependency, lock entry and Tauri config', () => {
    const root = copyReleaseFixture();
    prepareReleaseVersion({ root, version: '1.2.3' });
    assert.doesNotThrow(() => assertReleaseVersion({ root, version: 'v1.2.3' }));

    const internalNames = new Set(PUBLISHABLE_WORKSPACES.map(({ name }) => name));
    for (const relativePath of RELEASE_MANIFEST_PATHS) {
      const manifest = readJson(root, relativePath);
      assert.equal(manifest.version, '1.2.3', relativePath);
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const [name, range] of Object.entries(manifest[section] ?? {})) {
          if (internalNames.has(name)) assert.equal(range, '^1.2.3', `${relativePath} ${name}`);
        }
      }
      const bytes = readFileSync(join(root, relativePath), 'utf8');
      assert.match(bytes, /\r\n/, `${relativePath} keeps CRLF`);
      assert.doesNotMatch(bytes, /(?<!\r)\n/, `${relativePath} has no mixed LF endings`);
    }

    assert.equal(readJson(root, TAURI_CONFIG_PATH).version, '1.2.3');
    const lock = readJson(root, LOCKFILE_PATH);
    assert.equal(lock.version, '1.2.3');
    assert.equal(lock.packages[''].version, '1.2.3');
    for (const { path } of PUBLISHABLE_WORKSPACES) {
      assert.equal(lock.packages[path].version, '1.2.3', `${path} lock version`);
    }
  });

  it('reports every mismatch instead of allowing a partially versioned release', () => {
    const root = copyReleaseFixture();
    prepareReleaseVersion({ root, version: '1.2.3' });
    const corePath = join(root, 'packages/core/package.json');
    const core = JSON.parse(readFileSync(corePath, 'utf8'));
    core.version = '1.2.4';
    core.dependencies['@omnicross/contracts'] = '^0.1.0';
    writeFileSync(corePath, `${JSON.stringify(core, null, 2)}\r\n`.replace(/(?<!\r)\n/g, '\r\n'), 'utf8');

    assert.throws(
      () => assertReleaseVersion({ root, version: '1.2.3' }),
      (error) => {
        assert.match(error.message, /packages\/core\/package\.json version is "1\.2\.4"/);
        assert.match(error.message, /@omnicross\/contracts range is \^0\.1\.0/);
        return true;
      },
    );
  });

  it('keeps the checked-in release state internally consistent', () => {
    const version = readJson(repo, 'package.json').version;
    assert.doesNotThrow(() => assertReleaseVersion({ root: repo, version }));
  });

  it('gates release creation on checked-in versions and publishes npm before finalizing', () => {
    const workflow = readFileSync(join(repo, '.github', 'workflows', 'release.yml'), 'utf8');
    const check = 'node scripts/release-version.mjs check "$VERSION"';
    assert.ok(workflow.indexOf(check) > -1, 'workflow runs the unified version check');
    assert.ok(workflow.indexOf(check) < workflow.indexOf('find_release()'), 'check runs before draft creation');
    assert.doesNotMatch(workflow, /c\.version='\$VERSION'/, 'workflow never patches only the Tauri version');
    assert.match(workflow, /publish-npm:/);
    assert.match(workflow, /node scripts\/publish-workspaces\.mjs "\$VERSION"/);
    assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    assert.match(workflow, /finalize-updater:[\s\S]*needs: \[prepare-release, build, publish-npm\]/);
  });
});
