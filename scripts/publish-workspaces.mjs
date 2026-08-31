#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PUBLISHABLE_WORKSPACES,
  assertReleaseVersion,
  normalizeStableVersion,
} from './release-version.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDir, '..');

function defaultRunNpm(args, { root, inherit = false, env = process.env } = {}) {
  const windows = process.platform === 'win32';
  const executable = windows ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const commandArgs = windows ? ['/d', '/s', '/c', 'npm', ...args] : args;
  const result = spawnSync(executable, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    env,
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function parseVersion(stdout) {
  const value = stdout.trim();
  if (!value) return '';
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return value;
  }
}

function lookupPublishedVersion({ name, version, root, env, runNpm }) {
  const spec = `${name}@${version}`;
  const result = runNpm(['view', spec, 'version', '--json'], { root, env });
  if (result.status === 0) {
    const publishedVersion = parseVersion(result.stdout);
    if (publishedVersion !== version) {
      throw new Error(`Registry returned ${JSON.stringify(publishedVersion)} for ${spec}.`);
    }
    return true;
  }
  if (/\bE404\b|404 Not Found/i.test(result.stderr)) return false;
  throw new Error(`Could not determine whether ${spec} exists: ${result.stderr.trim() || `npm exited ${result.status}`}`);
}

export async function publishWorkspaces({
  root = defaultRoot,
  version,
  env = process.env,
  runNpm = defaultRunNpm,
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  logger = console,
}) {
  const targetRoot = resolve(root);
  const expectedVersion = normalizeStableVersion(version);
  if (!env.NODE_AUTH_TOKEN) {
    throw new Error('NODE_AUTH_TOKEN is required to publish @omnicross packages.');
  }
  assertReleaseVersion({ root: targetRoot, version: expectedVersion });

  for (const { name } of PUBLISHABLE_WORKSPACES) {
    const lookup = () => lookupPublishedVersion({
      name,
      version: expectedVersion,
      root: targetRoot,
      env,
      runNpm,
    });
    if (lookup()) {
      logger.info(`[npm] ${name}@${expectedVersion} already exists; skipping.`);
      continue;
    }

    logger.info(`[npm] publishing ${name}@${expectedVersion}`);
    const result = runNpm(
      ['publish', '--workspace', name, '--access', 'public', '--provenance'],
      { root: targetRoot, env, inherit: true },
    );
    if (result.status !== 0) throw new Error(`npm publish failed for ${name}@${expectedVersion}.`);

    let visible = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (lookup()) {
        visible = true;
        break;
      }
      if (attempt < 4) await sleep((attempt + 1) * 2_000);
    }
    if (!visible) throw new Error(`${name}@${expectedVersion} was not visible on npm after publication.`);
  }

  logger.info(`[npm] all @omnicross packages are published at ${expectedVersion}.`);
  return expectedVersion;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [rawVersion, ...extra] = process.argv.slice(2);
  if (!rawVersion || extra.length > 0) {
    process.stderr.write('Usage: node scripts/publish-workspaces.mjs <X.Y.Z>\n');
    process.exitCode = 1;
  } else {
    publishWorkspaces({ version: rawVersion }).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
