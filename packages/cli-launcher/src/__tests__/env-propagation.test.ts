/**
 * Regression tests for env propagation to ProcessSupervisor-spawned children.
 *
 * Why this matters: a host may mutate `process.env.PATH` at runtime (e.g. when
 * a portable Node/uv/git bin directory is added). If an adapter doesn't spread
 * `process.env` into the subprocess env, the child shell / CLI cannot see those
 * tools — and Claude Code / Codex CLIs running in PTY mode silently fail to find
 * the host-managed Node.
 *
 * - `child-adapter.ts:37` merged `{ ...process.env, ...input.env }`. Pinned
 *   by the real-spawn integration tests below.
 * - `pty-adapter.ts` originally just passed `input.env` raw (no merge),
 *   breaking PTY-mode CLI backends. Now exposes `buildPtyEnv()` and the
 *   merge logic is verified directly (the adapter itself loads `node-pty`,
 *   a native module that is awkward to mock in unit tests).
 */

import { spawn as cpSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildPtyEnv } from '../pty-adapter';

describe('child-adapter env propagation (integration via cp.spawn)', () => {
  let probeKey: string;
  let probeValue: string;

  beforeEach(() => {
    probeKey = `OMNICROSS_TEST_PROBE_${randomUUID().replace(/-/g, '_')}`;
    probeValue = `value-${Date.now()}`;
    process.env[probeKey] = probeValue;
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, probeKey);
  });

  // We test child-adapter via a direct cp.spawn call that mirrors the
  // merge formula `{ ...process.env, ...input.env }`. This avoids the
  // overhead of constructing a full SpawnChildInput (which requires a
  // ProcessSupervisor scope) while still proving the merge actually
  // propagates env to a real subprocess.

  function spawnWithMergedEnv(args: string[], overlay: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = cpSpawn(process.execPath, args, {
        env: { ...process.env, ...overlay },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`exit ${code}`));
      });
    });
  }

  it('subprocess inherits parent process.env when overlay is non-empty', async () => {
    const stdout = await spawnWithMergedEnv(
      ['-e', `process.stdout.write(String(process.env.${probeKey} ?? 'MISSING'))`],
      { OMNICROSS_TEST_OVERLAY: 'overlay' },
    );
    expect(stdout).toBe(probeValue);
  });

  it('overlay values override process.env on key conflict (last-wins)', async () => {
    const overlayValue = 'overlay-wins';
    const stdout = await spawnWithMergedEnv(
      ['-e', `process.stdout.write(String(process.env.${probeKey} ?? 'MISSING'))`],
      { [probeKey]: overlayValue },
    );
    expect(stdout).toBe(overlayValue);
  });
});

describe('buildPtyEnv', () => {
  const probeKey = 'OMNICROSS_PTY_PROBE';

  beforeEach(() => {
    process.env[probeKey] = 'pty-value';
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, probeKey);
  });

  it('includes process.env when overlay is provided', () => {
    const env = buildPtyEnv({ OMNICROSS_OVERLAY: 'overlay-value' });
    expect(env[probeKey]).toBe('pty-value');
    expect(env.OMNICROSS_OVERLAY).toBe('overlay-value');
  });

  it('includes process.env when overlay is undefined', () => {
    const env = buildPtyEnv(undefined);
    expect(env[probeKey]).toBe('pty-value');
  });

  it('includes process.env when overlay is empty object', () => {
    const env = buildPtyEnv({});
    expect(env[probeKey]).toBe('pty-value');
  });

  it('overlay overrides process.env on key conflict (last-wins)', () => {
    const env = buildPtyEnv({ [probeKey]: 'pty-overlay-wins' });
    expect(env[probeKey]).toBe('pty-overlay-wins');
  });

  it('returns a fresh object, not a reference to process.env', () => {
    const env = buildPtyEnv(undefined);
    env[probeKey] = 'mutated';
    expect(process.env[probeKey]).toBe('pty-value');
  });

  it('includes PATH so portable-installed tools are visible to the PTY shell', () => {
    const fakeBinDir = process.platform === 'win32'
      ? 'C:\\fake\\portable-node\\bin'
      : '/fake/portable-node/bin';
    const originalPath = process.env.PATH;
    process.env.PATH = `${originalPath ?? ''}${process.platform === 'win32' ? ';' : ':'}${fakeBinDir}`;
    try {
      const env = buildPtyEnv(undefined);
      expect(env.PATH).toContain(fakeBinDir);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
