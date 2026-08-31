import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { PUBLISHABLE_WORKSPACES } from '../release-version.mjs';
import { publishWorkspaces } from '../publish-workspaces.mjs';

const repo = join(import.meta.dirname, '..', '..');
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;

function registryRunner(initiallyPublished = [], { visibilityDelayLookups = 0 } = {}) {
  const published = new Set(initiallyPublished);
  const delayedVisibility = new Map();
  const calls = [];
  return {
    calls,
    runNpm(args) {
      calls.push(args);
      if (args[0] === 'view') {
        const spec = args[1];
        if (!published.has(spec)) {
          return { status: 1, stdout: '', stderr: 'npm error code E404' };
        }
        const remainingLookups = delayedVisibility.get(spec) ?? 0;
        if (remainingLookups > 0) {
          delayedVisibility.set(spec, remainingLookups - 1);
          return { status: 1, stdout: '', stderr: 'npm error code E404' };
        }
        return { status: 0, stdout: JSON.stringify(version), stderr: '' };
      }
      if (args[0] === 'publish') {
        const name = args[args.indexOf('--workspace') + 1];
        const spec = `${name}@${version}`;
        published.add(spec);
        delayedVisibility.set(spec, visibilityDelayLookups);
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected npm command: ${args.join(' ')}`);
    },
  };
}

describe('workspace publication contract', () => {
  it('publishes missing packages in dependency order and skips an existing exact version', async () => {
    const first = PUBLISHABLE_WORKSPACES[0].name;
    const registry = registryRunner([`${first}@${version}`]);

    await publishWorkspaces({
      root: repo,
      version,
      env: { NODE_AUTH_TOKEN: 'test-token' },
      runNpm: registry.runNpm,
      sleep: async () => {},
      logger: { info() {} },
    });

    const publishedNames = registry.calls
      .filter(([command]) => command === 'publish')
      .map((args) => args[args.indexOf('--workspace') + 1]);
    assert.deepEqual(publishedNames, PUBLISHABLE_WORKSPACES.slice(1).map(({ name }) => name));
    for (const args of registry.calls.filter(([command]) => command === 'publish')) {
      assert.ok(args.includes('--access'));
      assert.ok(args.includes('public'));
      assert.ok(args.includes('--provenance'));
    }
    for (const args of registry.calls.filter(([command]) => command === 'view')) {
      assert.ok(args.includes('--prefer-online'));
    }
  });

  it('waits for a successfully published package to become visible', async () => {
    const registry = registryRunner([], { visibilityDelayLookups: 6 });

    await publishWorkspaces({
      root: repo,
      version,
      env: { NODE_AUTH_TOKEN: 'test-token' },
      runNpm: registry.runNpm,
      sleep: async () => {},
      logger: { info() {} },
    });
  });

  it('fails safely when authentication is absent or the registry lookup is inconclusive', async () => {
    await assert.rejects(
      publishWorkspaces({ root: repo, version, env: {}, runNpm: () => assert.fail('must not call npm') }),
      /NODE_AUTH_TOKEN/,
    );

    await assert.rejects(
      publishWorkspaces({
        root: repo,
        version,
        env: { NODE_AUTH_TOKEN: 'test-token' },
        runNpm: () => ({ status: 1, stdout: '', stderr: 'network timeout' }),
      }),
      /Could not determine whether/,
    );
  });
});
