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
    'packages/chatgpt-web/package.json',
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
    assert.equal(assertReleaseVersion({ root, version: 'v1.2.3' }), '1.2.3');

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

  it('rejects repository URLs that npm provenance cannot verify', () => {
    const root = copyReleaseFixture();
    const contractsPath = join(root, 'packages/contracts/package.json');
    const contracts = JSON.parse(readFileSync(contractsPath, 'utf8'));
    contracts.repository.url = 'git+https://github.com/DumoeDss/omnicross.git';
    writeFileSync(contractsPath, `${JSON.stringify(contracts, null, 2)}\n`, 'utf8');

    assert.throws(
      () => assertReleaseVersion({ root, version: contracts.version }),
      /packages\/contracts\/package\.json repository\.url is .*expected https:\/\/github\.com\/DumoeDss\/omnicross/,
    );
  });

  it('rejects unbundled private runtime dependencies but permits bundled and build-only use', () => {
    const root = copyReleaseFixture();
    prepareReleaseVersion({ root, version: '1.2.3' });
    const privateName = '@omnicross/private-release-fixture';
    const privateDirectory = join(root, 'packages', 'private-release-fixture');
    mkdirSync(privateDirectory);
    writeFileSync(join(privateDirectory, 'package.json'), JSON.stringify({
      name: privateName, version: '0.0.1', private: true,
    }));
    const daemonPath = join(root, 'packages/daemon/package.json');
    const daemon = readJson(root, 'packages/daemon/package.json');
    daemon.dependencies[privateName] = '^0.0.1';
    daemon.bundleDependencies = [];
    delete daemon.bundledDependencies;
    writeFileSync(daemonPath, JSON.stringify(daemon));

    assert.throws(() => assertReleaseVersion({ root, version: '1.2.3' }), error => {
      assert.match(error.message, /@omnicross\/private-release-fixture/);
      return true;
    });

    daemon.bundleDependencies = ['@omnicross/chatgpt-web', privateName];
    writeFileSync(daemonPath, JSON.stringify(daemon));
    assert.equal(assertReleaseVersion({ root, version: '1.2.3' }), '1.2.3');

    delete daemon.dependencies[privateName];
    daemon.devDependencies = { ...daemon.devDependencies, [privateName]: '^0.0.1' };
    daemon.bundleDependencies = ['@omnicross/chatgpt-web'];
    writeFileSync(daemonPath, JSON.stringify(daemon));
    assert.equal(assertReleaseVersion({ root, version: '1.2.3' }), '1.2.3');
  });
});
