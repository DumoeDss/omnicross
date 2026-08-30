import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, it } from 'vitest';

import { createImageContractHarness, type ImageContractHarness } from './contractHarness';

const run = promisify(execFile);
const python = process.env.OMNICROSS_PYTHON_SDK_EXECUTABLE;
const harnesses: ImageContractHarness[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it.skipIf(!python)('runs pinned official Python OpenAI SDK 3.5.0 generate/edit contract', async () => {
  const harness = await createImageContractHarness();
  harnesses.push(harness);
  const directory = await mkdtemp(join(tmpdir(), 'omnicross-python-images-'));
  directories.push(directory);
  const primary = join(directory, 'primary.png');
  const reference = join(directory, 'reference.jpg');
  const mask = join(directory, 'mask.png');
  await Promise.all([
    writeFile(primary, harness.inputPng, { mode: 0o600 }),
    writeFile(reference, harness.inputJpeg, { mode: 0o600 }),
    writeFile(mask, harness.maskPng, { mode: 0o600 }),
  ]);
  const script = new URL('./python/images_contract.py', import.meta.url);
  const noProxy = ['127.0.0.1', 'localhost', process.env.NO_PROXY, process.env.no_proxy]
    .filter((value): value is string => Boolean(value))
    .join(',');
  const result = await run(python!, [fileURLToPath(script)], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: {
      ...process.env,
      OMNICROSS_IMAGES_TOKEN: harness.token,
      OMNICROSS_IMAGES_BASE_URL: harness.baseURL,
      OMNICROSS_IMAGES_OUTPUT_SHA256: createHash('sha256').update(harness.outputBytes.png).digest('hex'),
      OMNICROSS_IMAGES_PRIMARY: primary,
      OMNICROSS_IMAGES_REFERENCE: reference,
      OMNICROSS_IMAGES_MASK: mask,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
    },
  });
  expect(JSON.parse(result.stdout.trim())).toEqual({ sdk: '3.5.0', generate: true, edit: true });
  expect(harness.capture.starts).toBe(2);
  const edit = harness.capture.requests[1];
  expect(edit?.action).toBe('edit');
  if (edit?.action === 'edit') {
    expect(edit.images.map((asset) => asset.mimeType)).toEqual(['image/png', 'image/jpeg']);
    expect(edit.mask?.hasAlpha).toBe(true);
  }
}, 45_000);
