import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, it, vi } from 'vitest';

import type { DaemonImageE2eHarness } from './daemonImageE2eHarness';
import { createDaemonImageE2eHarness } from './daemonImageE2eHarness';
import {
  SYNTHETIC_IMAGE_PNG,
  SYNTHETIC_OUTPUT_PNG,
} from './syntheticVerifiedImageProvider';

const run = promisify(execFile);
const python = process.env.OMNICROSS_PYTHON_SDK_EXECUTABLE;
const script = fileURLToPath(new URL('./python/images_daemon_contract.py', import.meta.url));
const harnesses: DaemonImageE2eHarness[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })));
});

async function setup(
  behavior: Parameters<typeof createDaemonImageE2eHarness>[0] = {},
): Promise<{ harness: DaemonImageE2eHarness; directory: string }> {
  const harness = await createDaemonImageE2eHarness(behavior);
  harnesses.push(harness);
  const directory = await mkdtemp(join(tmpdir(), 'omnicross-daemon-python-images-'));
  directories.push(directory);
  await Promise.all([
    writeFile(join(directory, 'primary.png'), SYNTHETIC_IMAGE_PNG, { mode: 0o600 }),
    writeFile(join(directory, 'mask.png'), SYNTHETIC_IMAGE_PNG, { mode: 0o600 }),
  ]);
  return { harness, directory };
}

function isolatedEnvironment(
  harness: DaemonImageE2eHarness,
  directory: string,
  mode: 'success' | 'failure' | 'cancel',
): NodeJS.ProcessEnv {
  const noProxy = ['127.0.0.1', 'localhost', process.env.NO_PROXY, process.env.no_proxy]
    .filter((value): value is string => Boolean(value))
    .join(',');
  return {
    PATH: process.env.PATH,
    Path: process.env.Path,
    PATHEXT: process.env.PATHEXT,
    SYSTEMROOT: process.env.SYSTEMROOT,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    HOME: directory,
    USERPROFILE: directory,
    XDG_CACHE_HOME: join(directory, 'cache'),
    XDG_CONFIG_HOME: join(directory, 'config'),
    TMPDIR: directory,
    TEMP: directory,
    TMP: directory,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    OMNICROSS_IMAGES_MODE: mode,
    OMNICROSS_IMAGES_TOKEN: harness.token,
    OMNICROSS_IMAGES_BASE_URL: harness.baseURL,
    OMNICROSS_IMAGES_OUTPUT_SHA256:
      createHash('sha256').update(SYNTHETIC_OUTPUT_PNG).digest('hex'),
    OMNICROSS_IMAGES_PRIMARY: join(directory, 'primary.png'),
    OMNICROSS_IMAGES_MASK: join(directory, 'mask.png'),
  };
}

async function runContract(
  harness: DaemonImageE2eHarness,
  directory: string,
  mode: 'success' | 'failure',
): Promise<unknown> {
  const result = await run(python!, [script], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: isolatedEnvironment(harness, directory, mode),
  });
  return JSON.parse(result.stdout.trim());
}

async function cancelContract(
  harness: DaemonImageE2eHarness,
  directory: string,
): Promise<void> {
  const child = spawn(python!, [script], {
    cwd: directory,
    windowsHide: true,
    stdio: 'ignore',
    env: isolatedEnvironment(harness, directory, 'cancel'),
  });
  const exited = once(child, 'exit');
  const guard = setTimeout(() => child.kill(), 90_000);
  guard.unref();
  try {
    await Promise.race([
      vi.waitFor(() => expect(harness.capture.starts).toBe(1), {
        timeout: 90_000,
        interval: 100,
      }),
      exited.then(([code, signal]) => {
        throw new Error(`Python cancellation client exited early (${String(code)}/${String(signal)})`);
      }),
    ]);
    expect(child.kill()).toBe(true);
    await exited;
  } finally {
    clearTimeout(guard);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

it.skipIf(!python)('runs pinned OpenAI Python SDK 3.5.0 generate and multipart edit/mask', async () => {
  const { harness, directory } = await setup();
  const digest = createHash('sha256').update(SYNTHETIC_OUTPUT_PNG).digest('hex');
  await expect(runContract(harness, directory, 'success')).resolves.toEqual({
    sdk: '3.5.0',
    mode: 'success',
    generate: { count: 1, sha256: digest },
    edit: { count: 1, sha256: digest },
  });
  expect(harness.capture.starts).toBe(2);
  const edit = harness.capture.requests[1];
  expect(edit?.action).toBe('edit');
  if (edit?.action !== 'edit') throw new Error('expected captured Python edit request');
  expect(edit.images).toHaveLength(1);
  expect(edit.images[0]).toMatchObject({ mimeType: 'image/png', width: 1, height: 1 });
  expect(edit.mask).toMatchObject({ mimeType: 'image/png', hasAlpha: true });
}, 120_000);

it.skipIf(!python)('parses the stable provider failure response', async () => {
  const failed = await setup({ failWith: 'image_generation_failed' });
  await expect(runContract(failed.harness, failed.directory, 'failure')).resolves.toEqual({
    sdk: '3.5.0',
    mode: 'failure',
    status: 502,
    code: 'image_generation_failed',
  });
  await failed.harness.close();
}, 120_000);

it.skipIf(!python)('propagates Python client process cancellation and releases resources', async () => {
  const cancelled = await setup({
    beforeComplete: (_request, context) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      context.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }),
  });
  await cancelContract(cancelled.harness, cancelled.directory);
  await expect.poll(() => cancelled.harness.capture.cancels).toBe(1);
  await expect.poll(() => cancelled.harness.daemon.imageRuntimeManager.resourceStatus())
    .toMatchObject({
      queue: { activeJobs: 0, waitingJobs: 0 },
      temporary: { activeScopes: 0, totalBytes: 0 },
    });
}, 180_000);
