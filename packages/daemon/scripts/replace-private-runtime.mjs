import * as fs from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function capture(path) {
  const info = fs.lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || relative(path, fs.realpathSync(path)) !== '') {
    throw new Error(`Runtime directory must be a physical directory, not a link or junction: ${path}`);
  }
  return { path, dev: info.dev, ino: info.ino };
}

function assertIdentity(expected, path = expected.path) {
  const actual = capture(path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(`Runtime directory identity changed: ${path}`);
  }
}

// The callback fills a run-owned stage; it must not mutate the installed target.
// Keeping this transaction separate makes parent-redirection failures testable.
export function replacePrivateRuntime({ daemon, populate, validate }, operations = fs) {
  const parents = [capture(resolve(daemon))];
  const checkParents = () => parents.forEach((identity) => assertIdentity(identity));
  for (const child of ['node_modules', '@omnicross']) {
    checkParents();
    const path = join(parents.at(-1).path, child);
    if (!fs.existsSync(path)) fs.mkdirSync(path);
    parents.push(capture(path));
  }
  const scope = parents.at(-1).path;
  checkParents();
  const target = join(scope, 'chatgpt-web');
  const original = fs.existsSync(target) ? capture(target) : null;
  const stage = fs.mkdtempSync(join(scope, '.chatgpt-web-stage-'));
  const stageIdentity = capture(stage);
  const runtime = join(stage, 'runtime');
  const backup = join(scope, `.chatgpt-web-backup-${randomUUID()}`);
  let staged;
  let backedUp = false;
  let installed = false;
  let committed = false;
  let rollbackFailed = false;
  const failures = [];
  const checkStage = () => { checkParents(); assertIdentity(stageIdentity); };

  try {
    fs.mkdirSync(runtime);
    populate(runtime);
    validate(runtime);
    staged = capture(runtime);
    checkStage();
    if (original) {
      assertIdentity(original, target);
      // Never move an unrelated physical package into our cleanup-owned backup.
      const manifest = JSON.parse(fs.readFileSync(join(target, 'package.json'), 'utf8'));
      if (manifest.name !== '@omnicross/chatgpt-web' || manifest.private !== true) {
        throw new Error(`Refusing to replace an unrelated runtime directory: ${target}`);
      }
      checkStage();
      assertIdentity(original, target);
      operations.renameSync(target, backup);
      backedUp = true;
    } else if (fs.existsSync(target)) {
      throw new Error(`Runtime target appeared while staging: ${target}`);
    }
    checkStage();
    assertIdentity(staged, runtime);
    operations.renameSync(runtime, target);
    installed = true;
    checkParents();
    assertIdentity(staged, target);
    validate(target);
    // Full installed-tree validation is the commit boundary. Cleanup failures
    // after this point must never roll back the successfully installed runtime.
    committed = true;
  } catch (error) {
    failures.push(error);
    try {
      if (installed) {
        checkStage();
        assertIdentity(staged, target);
        operations.renameSync(target, runtime);
        installed = false;
      }
      if (backedUp) {
        checkStage();
        assertIdentity(original, backup);
        if (fs.existsSync(target)) throw new Error(`Rollback target is occupied: ${target}`);
        operations.renameSync(backup, target);
        backedUp = false;
      }
    } catch (rollbackError) {
      rollbackFailed = true;
      failures.push(rollbackError);
    }
  }

  if (committed && backedUp) {
    try {
      checkParents();
      assertIdentity(original, backup);
      operations.rmSync(backup, { recursive: true });
      backedUp = false;
    } catch (error) {
      failures.push(error);
    }
  }
  if (!rollbackFailed) {
    try {
      checkStage();
      operations.rmSync(stage, { recursive: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    const state = committed ? 'committed-with-cleanup-failures' : rollbackFailed ? 'rollback-failed' : 'not-committed';
    throw new AggregateError(failures,
      `Private runtime ${state}; target=${target}; stage=${stage}; backup=${backedUp ? backup : 'none'}`);
  }
}
