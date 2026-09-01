import type http from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import { ImageGenerationError } from '../../errors';
import { InMemoryImageReferenceStore } from '../../ports';
import {
  ImageRequestResourceScope,
  createImageRequestResourceScope,
} from '../TemporaryImageAsset';
import { readJsonBody } from '../readJsonBody';
import { readMultipartEdit } from '../readMultipartEdit';
import { resolveImageInput } from '../resolveImageInput';
import { DEFAULT_IMAGE_API_LIMITS, type ImageApiLimits, type ImageApiRuntime } from '../types';
import { assertCompatibleMask, validateRaster } from '../validateRaster';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function request(chunks: readonly Uint8Array[], headers: http.IncomingHttpHeaders): http.IncomingMessage {
  const stream = Readable.from(chunks.map((chunk) => Buffer.from(chunk))) as http.IncomingMessage;
  Object.defineProperty(stream, 'headers', { value: headers, configurable: true });
  return stream;
}

function limits(overrides: Partial<ImageApiLimits> = {}): ImageApiLimits {
  return { ...DEFAULT_IMAGE_API_LIMITS, ...overrides };
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'omnicross-images-test-'));
  roots.push(value);
  return value;
}

async function scope(custom = limits()): Promise<ImageRequestResourceScope> {
  return createImageRequestResourceScope(custom, new AbortController().signal, await root());
}

async function png(width = 2, height = 2, alpha = true): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 1, g: 2, b: 3, alpha: 0.5 } : { r: 1, g: 2, b: 3 },
    },
  }).png().toBuffer();
}

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).jpeg().toBuffer();
}

async function webp(): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 2, channels: 4, background: '#12345678' } }).webp().toBuffer();
}

async function animatedWebp(): Promise<Buffer> {
  const bytes = Buffer.alloc(2 * 4 * 4);
  for (let pixel = 0; pixel < 8; pixel += 1) {
    bytes[(pixel * 4)] = pixel < 4 ? 255 : 0;
    bytes[(pixel * 4) + 2] = pixel < 4 ? 0 : 255;
    bytes[(pixel * 4) + 3] = 255;
  }
  return sharp(bytes, {
    raw: { width: 2, height: 4, channels: 4, pageHeight: 2 },
  }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
}

async function one(bytes: Uint8Array): Promise<AsyncIterable<Uint8Array>> {
  return (async function* source() { yield bytes; })();
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(ImageGenerationError);
  expect((error as ImageGenerationError).code).toBe(code);
}

describe('bounded JSON body reader', () => {
  it('decodes chunked strict UTF-8 JSON', async () => {
    const bytes = Buffer.from('{"prompt":"雪"}');
    const result = await readJsonBody(
      request([bytes.subarray(0, 12), bytes.subarray(12)], { 'content-type': 'application/json' }),
      { maxBytes: 128, signal: new AbortController().signal },
    );
    expect(result).toEqual({ prompt: '雪' });
  });

  it('rejects an oversized declaration before consuming the body', async () => {
    let reads = 0;
    const source = new Readable({
      read() {
        reads += 1;
        this.push('{}');
        this.push(null);
      },
    }) as http.IncomingMessage;
    Object.defineProperty(source, 'headers', {
      value: { 'content-type': 'application/json', 'content-length': '65' },
    });
    await expectCode(
      readJsonBody(source, { maxBytes: 64, signal: new AbortController().signal }),
      'image_too_large',
    );
    expect(reads).toBe(0);
  });

  it('rejects observed overflow and malformed UTF-8', async () => {
    await expectCode(
      readJsonBody(request([Buffer.alloc(65, 0x20)], { 'content-type': 'application/json' }), {
        maxBytes: 64,
        signal: new AbortController().signal,
      }),
      'image_too_large',
    );
    await expectCode(
      readJsonBody(request([Uint8Array.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d])], {
        'content-type': 'application/json',
      }), { maxBytes: 64, signal: new AbortController().signal }),
      'invalid_image_request',
    );
  });

  it('accepts the built-in Codex edit envelope for a 2.49 MiB image by default', async () => {
    const encoded = 'A'.repeat(Math.ceil((2_490_000 / 3)) * 4);
    const body = Buffer.from(JSON.stringify({
      images: [{ image_url: `data:image/png;base64,${encoded}` }],
      prompt: 'edit',
      model: 'gpt-image-2',
      quality: 'auto',
      size: 'auto',
    }));
    const result = await readJsonBody(
      request([body], {
        'content-type': 'application/json',
        'content-length': String(body.byteLength),
      }),
      {
        maxBytes: DEFAULT_IMAGE_API_LIMITS.maxJsonBytes,
        signal: new AbortController().signal,
      },
    );
    expect(result).toMatchObject({ model: 'gpt-image-2', quality: 'auto' });
  });

  it('propagates abort without parsing partial JSON', async () => {
    const controller = new AbortController();
    controller.abort(new Error('secret abort reason'));
    await expectCode(
      readJsonBody(request([Buffer.from('{}')], { 'content-type': 'application/json' }), {
        maxBytes: 64,
        signal: controller.signal,
      }),
      'request_cancelled',
    );
  });
});

describe('temporary assets and complete raster validation', () => {
  it('uses private request directories, fresh streams, and idempotent cleanup', async () => {
    const tempRoot = await root();
    const resource = await createImageRequestResourceScope(limits(), new AbortController().signal, tempRoot);
    const bytes = await png();
    const staged = await resource.materialize(await one(bytes));
    const asset = await validateRaster(staged, limits());
    expect('path' in asset).toBe(false);
    const first = Buffer.from(await new Response(await asset.open()).arrayBuffer());
    const second = Buffer.from(await new Response(await asset.open()).arrayBuffer());
    expect(first).toEqual(bytes);
    expect(second).toEqual(bytes);
    expect((await readdir(tempRoot)).length).toBe(1);
    await resource.cleanup();
    await resource.cleanup();
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it.each([
    ['png', png, 'image/png'],
    ['jpeg', jpeg, 'image/jpeg'],
    ['webp', webp, 'image/webp'],
  ] as const)('derives and fully decodes %s', async (_name, fixture, mimeType) => {
    const resource = await scope();
    try {
      const bytes = await fixture();
      const asset = await validateRaster(await resource.materialize(await one(bytes)), limits());
      expect(asset).toMatchObject({ mimeType, width: 2, height: 2, independentlyDecodable: true });
    } finally {
      await resource.cleanup();
    }
  });

  it('rejects corrupt/truncated containers and pixel budgets', async () => {
    const resource = await scope();
    try {
      const bytes = await png(20, 20);
      await expectCode(
        validateRaster(await resource.materialize(await one(bytes.subarray(0, bytes.length - 8))), limits()),
        'unsupported_image_type',
      );
      await expectCode(
        validateRaster(await resource.materialize(await one(bytes)), limits({ maxPixels: 100, maxRawBytes: 400 })),
        'image_too_large',
      );
    } finally {
      await resource.cleanup();
    }
  });

  it('rejects animated supported containers rather than accepting the first frame', async () => {
    const resource = await scope();
    try {
      await expectCode(
        validateRaster(await resource.materialize(await one(await animatedWebp())), limits()),
        'unsupported_image_type',
      );
    } finally {
      await resource.cleanup();
    }
  });

  it('requires mask format, dimensions, and a real alpha channel', async () => {
    const resource = await scope();
    try {
      const primary = await validateRaster(await resource.materialize(await one(await png())), limits());
      const validMask = await validateRaster(await resource.materialize(await one(await png())), limits());
      expect(() => assertCompatibleMask(primary, validMask)).not.toThrow();
      const noAlpha = await validateRaster(await resource.materialize(await one(await png(2, 2, false))), limits());
      expect(() => assertCompatibleMask(primary, noAlpha)).toThrowError(/invalid/i);
      const wrongSize = await validateRaster(await resource.materialize(await one(await png(3, 2))), limits());
      expect(() => assertCompatibleMask(primary, wrongSize)).toThrowError(/invalid/i);
    } finally {
      await resource.cleanup();
    }
  });
});

function multipart(boundary: string, fields: Readonly<Record<string, string>>, files: readonly {
  readonly name: string;
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}[]): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`,
    ));
    chunks.push(Buffer.from(file.bytes));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

describe('multipart edit ingestion', () => {
  it('preserves image/image[] order, ignores caller MIME, and keeps mask distinct', async () => {
    const boundary = 'safe-boundary-123';
    const first = await png();
    const second = await jpeg();
    const mask = await png();
    const body = multipart(boundary, { prompt: 'edit', n: '1' }, [
      { name: 'image', filename: '../../first.txt', contentType: 'text/plain', bytes: first },
      { name: 'image[]', filename: 'second.png', contentType: 'image/png', bytes: second },
      { name: 'mask', filename: 'mask.png', contentType: 'image/png', bytes: mask },
    ]);
    const resource = await scope();
    try {
      const parsed = await readMultipartEdit(
        request([body], {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(body.length),
        }),
        resource,
        limits(),
        new AbortController().signal,
      );
      expect(parsed.fields).toEqual({ prompt: 'edit', n: '1' });
      expect(parsed.images.map((asset) => asset.mimeType)).toEqual(['image/png', 'image/jpeg']);
      expect(parsed.mask?.mimeType).toBe('image/png');
    } finally {
      await resource.cleanup();
    }
  });

  it('rejects duplicate masks and truncated files', async () => {
    const boundary = 'safe-boundary-duplicate';
    const image = await png();
    const body = multipart(boundary, { prompt: 'edit' }, [
      { name: 'image', filename: 'a.png', contentType: 'image/png', bytes: image },
      { name: 'mask', filename: 'm1.png', contentType: 'image/png', bytes: image },
      { name: 'mask', filename: 'm2.png', contentType: 'image/png', bytes: image },
    ]);
    const resource = await scope();
    try {
      await expectCode(readMultipartEdit(
        request([body], { 'content-type': `multipart/form-data; boundary=${boundary}` }),
        resource,
        limits(),
        new AbortController().signal,
      ), 'invalid_image_request');
    } finally {
      await resource.cleanup();
    }
  });

  it('rejects the injected header-pair limit and a request that closes before its final boundary', async () => {
    const boundary = 'safe-boundary-abuse';
    const image = await png();
    const body = multipart(boundary, { prompt: 'edit' }, [
      { name: 'image', filename: 'a.png', contentType: 'image/png', bytes: image },
    ]);
    const headerScope = await scope();
    try {
      await expectCode(readMultipartEdit(
        request([body], { 'content-type': `multipart/form-data; boundary=${boundary}` }),
        headerScope,
        limits({ maxHeaderPairs: 1 }),
        new AbortController().signal,
      ), 'image_too_large');
    } finally {
      await headerScope.cleanup();
    }

    const premature = new Readable({
      read() {
        this.push(body.subarray(0, Math.floor(body.length / 2)));
        this.destroy();
      },
    }) as http.IncomingMessage;
    Object.defineProperty(premature, 'headers', {
      value: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    const closeScope = await scope();
    try {
      await expectCode(readMultipartEdit(
        premature,
        closeScope,
        limits(),
        new AbortController().signal,
      ), 'invalid_image_request');
    } finally {
      await closeScope.cleanup();
    }
  });
});

describe('closed JSON image inputs', () => {
  it('does not apply the remote-URL length limit to an inline data URL', async () => {
    const resource = await scope();
    const bytes = await png();
    const runtime: ImageApiRuntime = {
      tenantId: 'tenant-a',
      providerId: 'fake',
      defaultModel: 'gpt-image-2',
      modelAliases: new Map(),
      limits: limits({ maxRemoteUrlBytes: 32 }),
    };
    const imageUrl = `data:image/png;base64,${bytes.toString('base64')}`;
    expect(Buffer.byteLength(imageUrl, 'utf8')).toBeGreaterThan(runtime.limits.maxRemoteUrlBytes);
    try {
      const asset = await resolveImageInput(
        { image_url: imageUrl },
        runtime,
        resource,
        new AbortController().signal,
      );
      expect(asset).toMatchObject({ mimeType: 'image/png', width: 2, height: 2 });
    } finally {
      await resource.cleanup();
    }
  });

  it('decodes bounded data URLs through the common validator', async () => {
    const resource = await scope();
    const bytes = await png();
    const runtime: ImageApiRuntime = {
      tenantId: 'tenant-a',
      providerId: 'fake',
      defaultModel: 'gpt-image-1',
      modelAliases: new Map(),
      limits: limits(),
    };
    try {
      const asset = await resolveImageInput(
        { image_url: `data:image/png;base64,${bytes.toString('base64')}` },
        runtime,
        resource,
        new AbortController().signal,
      );
      expect(asset.mimeType).toBe('image/png');
      await expectCode(resolveImageInput(
        { image_url: 'https://example.test/private.png' },
        runtime,
        resource,
        new AbortController().signal,
      ), 'unsupported_capability');
      await expectCode(resolveImageInput(
        { image_url: 'https://example.test/private.png' },
        { ...runtime, limits: limits({ maxRemoteUrlBytes: 8 }) },
        resource,
        new AbortController().signal,
      ), 'invalid_image_request');
      await expectCode(resolveImageInput(
        { image_url: 'x', extra: 'secret' },
        runtime,
        resource,
        new AbortController().signal,
      ), 'invalid_image_request');
    } finally {
      await resource.cleanup();
    }
  });

  it('leases same-tenant references and hides cross-tenant references', async () => {
    const resource = await scope();
    const bytes = await png();
    const asset = await validateRaster(await resource.materialize(await one(bytes)), limits());
    const store = new InMemoryImageReferenceStore(() => 100);
    const saved = await store.save({
      tenantId: 'tenant-a',
      ttlMs: 1000,
      artifact: asset,
      metadata: {
        mimeType: asset.mimeType,
        byteLength: asset.byteLength,
        width: asset.width,
        height: asset.height,
      },
    });
    const runtime = (tenantId: string): ImageApiRuntime => ({
      tenantId,
      providerId: 'fake',
      defaultModel: 'gpt-image-1',
      modelAliases: new Map(),
      limits: limits(),
      referenceStore: store,
    });
    try {
      expect(await resolveImageInput(
        { file_id: saved.referenceId }, runtime('tenant-a'), resource, new AbortController().signal,
      )).toBe(asset);
      await expectCode(resolveImageInput(
        { file_id: saved.referenceId }, runtime('tenant-b'), resource, new AbortController().signal,
      ), 'image_reference_not_found');
    } finally {
      await resource.cleanup();
    }
  });

  it('reports expiry only to the owning tenant', async () => {
    const resource = await scope();
    let now = 100;
    const bytes = await png();
    const asset = await validateRaster(await resource.materialize(await one(bytes)), limits());
    const store = new InMemoryImageReferenceStore(() => now);
    const saved = await store.save({
      tenantId: 'tenant-a',
      ttlMs: 10,
      artifact: asset,
      metadata: {
        mimeType: asset.mimeType,
        byteLength: asset.byteLength,
        width: asset.width,
        height: asset.height,
      },
    });
    const runtime = (tenantId: string): ImageApiRuntime => ({
      tenantId,
      providerId: 'fake',
      defaultModel: 'gpt-image-1',
      modelAliases: new Map(),
      limits: limits(),
      referenceStore: store,
    });
    now = 110;
    try {
      await expectCode(resolveImageInput(
        { file_id: saved.referenceId }, runtime('tenant-a'), resource, new AbortController().signal,
      ), 'image_reference_expired');
      await expectCode(resolveImageInput(
        { file_id: saved.referenceId }, runtime('tenant-b'), resource, new AbortController().signal,
      ), 'image_reference_not_found');
    } finally {
      await resource.cleanup();
    }
  });
});
