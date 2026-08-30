import type http from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';

import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_IMAGE_API_LIMITS,
  IMAGE_REQUEST_DIRECTORY_MARKER_CONTENT,
  IMAGE_REQUEST_DIRECTORY_MARKER_NAME,
  type ImageApiRuntime,
} from '@omnicross/core/image-generation';
import { readMultipartEdit } from '@omnicross/core/image-generation/openai-images/readMultipartEdit';
import { resolveImageInput } from '@omnicross/core/image-generation/openai-images/resolveImageInput';

import { createDaemonImagePathResolver } from '../imagePathResolver';
import { DaemonImageTemporaryResourceFactory } from '../imageTemporaryResources';

const sandboxes: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'omnicross-image-temporary-'));
  sandboxes.push(root);
  return root;
}

afterEach(() => {
  const systemTemporary = resolve(tmpdir());
  for (const root of sandboxes.splice(0)) {
    const absolute = resolve(root);
    const rel = relative(systemTemporary, absolute);
    if (!isAbsolute(absolute) || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('refusing to clean an unverified temporary-resource sandbox');
    }
    rmSync(absolute, { recursive: true, force: true });
  }
});

function factory(root: string, limits: {
  maxActiveScopes: number;
  maxTotalBytes: number;
  maxTenantBytes: number;
}): { factory: DaemonImageTemporaryResourceFactory; workspace: string } {
  const applicationData = join(root, 'private-data');
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const systemTemporary = join(root, 'system-temporary');
  for (const path of [applicationData, workspace, home, systemTemporary]) {
    mkdirSync(path, { recursive: true });
  }
  const paths = createDaemonImagePathResolver({
    configPath: join(applicationData, 'config.json'),
    processDirectory: workspace,
    userHome: home,
    temporaryDirectory: systemTemporary,
  });
  return {
    factory: new DaemonImageTemporaryResourceFactory({
      paths,
      config: {
        ...limits,
        staleAfterMs: 60_000,
        cleanupIntervalMs: 10_000,
      },
    }),
    workspace,
  };
}

async function png(): Promise<Buffer> {
  return sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 1, g: 2, b: 3, alpha: 0.5 },
    },
  }).png().toBuffer();
}

function runtime(tenantId: string): ImageApiRuntime {
  return {
    tenantId,
    providerId: 'synthetic',
    defaultModel: 'gpt-image-2',
    modelAliases: new Map(),
    limits: DEFAULT_IMAGE_API_LIMITS,
  };
}

function request(body: Uint8Array, headers: http.IncomingHttpHeaders): http.IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]) as http.IncomingMessage;
  Object.defineProperty(stream, 'headers', { value: headers, configurable: true });
  return stream;
}

function multipart(boundary: string, image: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nedit\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="caller-name.png"\r\n` +
      'Content-Type: image/png\r\n\r\n',
    ),
    Buffer.from(image),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

describe('DaemonImageTemporaryResourceFactory', () => {
  it('enforces active-scope capacity, writes the fixed owner marker, and never writes to the workspace', async () => {
    const root = sandbox();
    const setup = factory(root, { maxActiveScopes: 1, maxTotalBytes: 1024, maxTenantBytes: 1024 });
    const first = await setup.factory.createResourceScope(
      DEFAULT_IMAGE_API_LIMITS,
      new AbortController().signal,
      'tenant-a',
    );
    await expect(setup.factory.createResourceScope(
      DEFAULT_IMAGE_API_LIMITS,
      new AbortController().signal,
      'tenant-b',
    )).rejects.toMatchObject({ code: 'image_too_large' });

    const [directory] = readdirSync(join(root, 'private-data', 'images', 'temporary'));
    expect(readFileSync(
      join(root, 'private-data', 'images', 'temporary', directory!, IMAGE_REQUEST_DIRECTORY_MARKER_NAME),
      'utf8',
    )).toBe(IMAGE_REQUEST_DIRECTORY_MARKER_CONTENT);
    expect(readdirSync(setup.workspace)).toEqual([]);
    await first.cleanup();
    expect(setup.factory.budget.status()).toEqual({ activeScopes: 0, totalBytes: 0, tenantCount: 0 });
  });

  it('atomically enforces per-tenant bytes across concurrent JSON data URLs', async () => {
    const image = await png();
    const setup = factory(sandbox(), {
      maxActiveScopes: 4,
      maxTotalBytes: image.byteLength * 2,
      maxTenantBytes: image.byteLength,
    });
    const scopes = await Promise.all([0, 1].map(() => setup.factory.createResourceScope(
      DEFAULT_IMAGE_API_LIMITS,
      new AbortController().signal,
      'tenant-a',
    )));
    const value = { image_url: `data:image/png;base64,${image.toString('base64')}` };
    const results = await Promise.allSettled(scopes.map((scope) => resolveImageInput(
      value,
      runtime('tenant-a'),
      scope,
      new AbortController().signal,
    )));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'image_too_large' },
    });
    await Promise.all(scopes.map((scope) => scope.cleanup()));
    expect(setup.factory.budget.status()).toEqual({ activeScopes: 0, totalBytes: 0, tenantCount: 0 });
  });

  it('atomically enforces global bytes across concurrent multipart tenants', async () => {
    const image = await png();
    const setup = factory(sandbox(), {
      maxActiveScopes: 4,
      maxTotalBytes: image.byteLength,
      maxTenantBytes: image.byteLength,
    });
    const tenants = ['tenant-a', 'tenant-b'] as const;
    const scopes = await Promise.all(tenants.map((tenantId) => setup.factory.createResourceScope(
      DEFAULT_IMAGE_API_LIMITS,
      new AbortController().signal,
      tenantId,
    )));
    const boundary = 'daemon-temporary-budget';
    const body = multipart(boundary, image);
    const results = await Promise.allSettled(scopes.map((scope) => readMultipartEdit(
      request(body, {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(body.byteLength),
      }),
      scope,
      DEFAULT_IMAGE_API_LIMITS,
      new AbortController().signal,
    )));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'image_too_large' },
    });
    await Promise.all(scopes.map((scope) => scope.cleanup()));
    expect(setup.factory.budget.status().totalBytes).toBe(0);
  });

  it('bounds concurrent spools and releases cancellation/partial writes during cleanup', async () => {
    const setup = factory(sandbox(), { maxActiveScopes: 4, maxTotalBytes: 6, maxTenantBytes: 6 });
    const scopes = await Promise.all(['tenant-a', 'tenant-b'].map((tenantId) =>
      setup.factory.createResourceScope(
        DEFAULT_IMAGE_API_LIMITS,
        new AbortController().signal,
        tenantId,
      )));
    const writers = await Promise.all(scopes.map((scope) => scope.createWriter({ kind: 'spool', maxBytes: 8 })));
    const results = await Promise.allSettled(writers.map((writer) => writer.write(Buffer.from('four'))));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'image_too_large' },
    });

    const controller = new AbortController();
    await Promise.all(scopes.map((scope) => scope.cleanup()));
    const cancelled = await setup.factory.createResourceScope(
      DEFAULT_IMAGE_API_LIMITS,
      controller.signal,
      'tenant-c',
    );
    const partial = cancelled.materialize((async function* source() {
      yield Buffer.from('part');
      controller.abort();
      yield Buffer.from('never');
    })());
    await expect(partial).rejects.toMatchObject({ code: 'request_cancelled' });
    await cancelled.cleanup();
    expect(setup.factory.budget.status()).toEqual({ activeScopes: 0, totalBytes: 0, tenantCount: 0 });
  });
});
