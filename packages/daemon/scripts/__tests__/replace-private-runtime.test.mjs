import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { replacePrivateRuntime } from '../replace-private-runtime.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'omnicross-runtime-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const daemon = join(root, 'daemon');
  const scope = join(daemon, 'node_modules', '@omnicross');
  const target = join(scope, 'chatgpt-web');
  const outside = join(root, 'outside');
  const saved = join(root, 'saved-scope');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, 'fingerprint'), 'untouched');
  function populate(path, value = 'new') {
    fs.writeFileSync(join(path, 'package.json'), JSON.stringify({ name: '@omnicross/chatgpt-web', private: true }));
    fs.writeFileSync(join(path, 'runtime'), value);
  }
  populate(target, 'old');
  const validate = (path) => assert.equal(fs.readFileSync(join(path, 'runtime'), 'utf8'), 'new');
  function redirect() {
    fs.renameSync(scope, saved);
    fs.symlinkSync(outside, scope, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const assertOutside = () => {
    assert.deepEqual(fs.readdirSync(outside), ['fingerprint']);
    assert.equal(fs.readFileSync(join(outside, 'fingerprint'), 'utf8'), 'untouched');
  };
  return { root, daemon, scope, target, saved, outside, populate, validate, redirect, assertOutside };
}

test('commits a validated replacement and retires only its own staging/backup', (t) => {
  const f = fixture(t);
  replacePrivateRuntime(f);
  assert.equal(fs.readFileSync(join(f.target, 'runtime'), 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(f.scope), ['chatgpt-web']);
  f.assertOutside();
});

test('restores the original target when installed-tree validation fails', (t) => {
  const f = fixture(t);
  assert.throws(() => replacePrivateRuntime({ ...f, validate(path) {
    f.validate(path);
    if (path === f.target) throw new Error('injected installed validation failure');
  } }), /not-committed/);
  assert.equal(fs.readFileSync(join(f.target, 'runtime'), 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(f.scope), ['chatgpt-web']);
  f.assertOutside();
});

test('rejects a junction target without following or replacing its contents', (t) => {
  const f = fixture(t);
  fs.rmSync(f.target, { recursive: true });
  fs.symlinkSync(f.outside, f.target, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => replacePrivateRuntime(f), /not a link or junction/);
  assert.deepEqual(fs.readdirSync(f.scope), ['chatgpt-web']);
  f.assertOutside();
});

test('rejects parent redirection before the forward swap and preserves the stage', (t) => {
  const f = fixture(t);
  assert.throws(() => replacePrivateRuntime({ ...f, populate(path) {
    f.populate(path);
    f.redirect();
  } }), /not-committed/);
  assert.equal(fs.readFileSync(join(f.saved, 'chatgpt-web', 'runtime'), 'utf8'), 'old');
  assert.equal(fs.readdirSync(f.saved).filter((name) => name.startsWith('.chatgpt-web-stage-')).length, 1);
  f.assertOutside();
});

test('refuses rollback through a redirected parent and retains truthful backup state', (t) => {
  const f = fixture(t);
  let renames = 0;
  assert.throws(() => replacePrivateRuntime(f, { ...fs, renameSync(from, to) {
    renames += 1;
    if (renames === 2) {
      f.redirect();
      throw new Error('injected install rename failure after redirection');
    }
    fs.renameSync(from, to);
  } }), /rollback-failed/);
  const entries = fs.readdirSync(f.saved);
  assert(!entries.includes('chatgpt-web'));
  const backup = entries.find((name) => name.startsWith('.chatgpt-web-backup-'));
  assert(backup);
  assert.equal(fs.readFileSync(join(f.saved, backup, 'runtime'), 'utf8'), 'old');
  assert(entries.some((name) => name.startsWith('.chatgpt-web-stage-')));
  f.assertOutside();
});

test('preserves the committed target when retiring a backup redirects the parent', (t) => {
  const f = fixture(t);
  assert.throws(() => replacePrivateRuntime(f, { ...fs, rmSync(path, options) {
    if (path.includes('.chatgpt-web-backup-')) {
      f.redirect();
      throw new Error('injected committed cleanup failure');
    }
    fs.rmSync(path, options);
  } }), /committed-with-cleanup-failures/);
  assert.equal(fs.readFileSync(join(f.saved, 'chatgpt-web', 'runtime'), 'utf8'), 'new');
  assert(fs.readdirSync(f.saved).some((name) => name.startsWith('.chatgpt-web-backup-')));
  assert(fs.readdirSync(f.saved).some((name) => name.startsWith('.chatgpt-web-stage-')));
  f.assertOutside();
});
