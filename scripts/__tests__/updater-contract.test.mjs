import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { assembleUpdaterManifest, runCli, validateUpdaterManifest, verifyUpdaterArtifacts } from '../updater-contract.mjs';

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'updater');
const signedFixtures = join(fixtures, 'signed');
const load = (name) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
const validate = (manifest) => validateUpdaterManifest({
  manifest,
  tag: 'v1.2.3',
  tauriVersion: '1.2.3',
});

describe('updater release contract', () => {
  it('resolves a draft release target commit without assuming its tag already exists', () => {
    const workflow = readFileSync(join(import.meta.dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8');
    assert.match(workflow, /\.target_commitish/);
    assert.match(workflow, /repos\/\$GITHUB_REPOSITORY\/commits\/\$RELEASE_TARGET/);
    assert.doesNotMatch(workflow, /git fetch --force origin "refs\/tags\/\$TAG:refs\/tags\/\$TAG"/);
  });

  it('accepts a complete supported matrix', () => assert.equal(validate(load('complete.json')), true));
  it('rejects a missing target', () => assert.throws(() => validate(load('missing-target.json')), /platforms must be exactly/));
  it('rejects a missing signature', () => assert.throws(() => validate(load('missing-signature.json')), /signature is missing/));
  it('rejects unsafe or mutable URLs', () => assert.throws(() => validate(load('unsafe-url.json')), /immutable HTTPS GitHub release asset/));
  it('rejects tag, manifest and Tauri version mismatches', () => {
    assert.throws(() => validate(load('mismatch-version.json')), /manifest version/);
    assert.throws(() => validateUpdaterManifest({ manifest: load('complete.json'), tag: 'v1.2.3', tauriVersion: '1.2.4' }), /Tauri version/);
    assert.throws(() => validateUpdaterManifest({ manifest: load('complete.json'), tag: 'v1.2.3-beta.1', tauriVersion: '1.2.3' }), /stable exact SemVer/);
  });
  it('assembles one platform map from signed build assets', () => {
    const assets = mkdtempSync(join(tmpdir(), 'omnicross-updater-contract-'));
    for (const name of [
      'Omnicross_1.2.3_x64-setup.exe',
      'Omnicross_1.2.3_universal.app.tar.gz',
      'Omnicross_1.2.3_amd64.AppImage',
    ]) {
      writeFileSync(join(assets, name), 'fixture');
      writeFileSync(join(assets, `${name}.sig`), `signature-for-${name}`);
    }
    const manifest = assembleUpdaterManifest({ assetsDir: assets, tag: 'v1.2.3', pubDate: '2026-01-01T00:00:00.000Z' });
    assert.equal(validate(manifest), true);
    assert.deepEqual(Object.keys(manifest.platforms).sort(), ['darwin-universal', 'linux-x86_64', 'windows-x86_64']);
  });

  it('cryptographically accepts artifacts signed by the configured updater key', () => {
    assert.equal(verifyUpdaterArtifacts({
      assetsDir: signedFixtures,
      publicKey: readFileSync(join(signedFixtures, 'public-key.txt'), 'utf8').trim(),
    }), true);
  });

  it('finalizer reads the configured key and verifies before writing latest.json', () => {
    const work = mkdtempSync(join(tmpdir(), 'omnicross-updater-finalizer-'));
    const tauriConfig = join(work, 'tauri.conf.json');
    const output = join(work, 'latest.json');
    const rejectedOutput = join(work, 'rejected-latest.json');
    const writeConfig = (publicKey) => writeFileSync(tauriConfig, JSON.stringify({
      version: '1.2.3',
      plugins: { updater: { pubkey: publicKey } },
    }));

    writeConfig(readFileSync(join(signedFixtures, 'public-key.txt'), 'utf8').trim());
    const manifest = runCli([
      '--assets', signedFixtures,
      '--output', output,
      '--tag', 'v1.2.3',
      '--tauri-config', tauriConfig,
    ]);
    assert.equal(validate(manifest), true);
    assert.equal(existsSync(output), true);

    writeConfig(readFileSync(join(signedFixtures, 'wrong-public-key.txt'), 'utf8').trim());
    assert.throws(() => runCli([
      '--assets', signedFixtures,
      '--output', rejectedOutput,
      '--tag', 'v1.2.3',
      '--tauri-config', tauriConfig,
    ]), /signature verification failed/i);
    assert.equal(existsSync(rejectedOutput), false);
  });

  it('rejects mutated bytes, a wrong key, and a malformed signature', () => {
    const publicKey = readFileSync(join(signedFixtures, 'public-key.txt'), 'utf8').trim();
    const copySignedFixtures = () => {
      const destination = mkdtempSync(join(tmpdir(), 'omnicross-updater-signed-'));
      for (const name of [
        'Omnicross_1.2.3_x64-setup.exe',
        'Omnicross_1.2.3_universal.app.tar.gz',
        'Omnicross_1.2.3_amd64.AppImage.tar.gz',
      ]) {
        copyFileSync(join(signedFixtures, name), join(destination, name));
        copyFileSync(join(signedFixtures, `${name}.sig`), join(destination, `${name}.sig`));
      }
      return destination;
    };

    const mutated = copySignedFixtures();
    writeFileSync(join(mutated, 'Omnicross_1.2.3_x64-setup.exe'), 'mutated updater bytes');
    assert.throws(() => verifyUpdaterArtifacts({ assetsDir: mutated, publicKey }), /signature verification failed/i);

    assert.throws(() => verifyUpdaterArtifacts({
      assetsDir: signedFixtures,
      publicKey: readFileSync(join(signedFixtures, 'wrong-public-key.txt'), 'utf8').trim(),
    }), /signature verification failed/i);

    const malformed = copySignedFixtures();
    writeFileSync(join(malformed, 'Omnicross_1.2.3_universal.app.tar.gz.sig'), 'not-a-minisign-signature');
    assert.throws(() => verifyUpdaterArtifacts({ assetsDir: malformed, publicKey }), /signature verification failed/i);
  });
});
