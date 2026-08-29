import { randomUUID } from 'node:crypto';

import type { ImageArtifactId } from '@omnicross/contracts/image-generation-types';
import { describe, expect, it, vi } from 'vitest';

import { ImageGenerationError } from '../../errors';
import { InMemoryImageAsset } from '../../ports';
import { serializeImageApiError } from '../imageApiErrors';
import {
  createSafeRemoteImageResolver,
  isBlockedRemoteAddress,
  type SafeRemotePinnedResponse,
} from '../safeRemoteImageResolver';
import { DEFAULT_IMAGE_API_LIMITS } from '../types';

function body(...chunks: Uint8Array[]): SafeRemotePinnedResponse['body'] {
  return Object.assign((async function* source() {
    for (const chunk of chunks) yield chunk;
  })(), { async dump() { /* consumed by the fake */ } });
}

function response(options: {
  statusCode?: number;
  headers?: Record<string, string>;
  chunks?: Uint8Array[];
} = {}): SafeRemotePinnedResponse {
  return {
    statusCode: options.statusCode ?? 200,
    headers: options.headers ?? {},
    body: body(...(options.chunks ?? [Uint8Array.of(1)])),
    async close() { /* no-op fake */ },
  };
}

function artifact() {
  return new InMemoryImageAsset(Uint8Array.of(1), {
    artifactId: randomUUID() as ImageArtifactId,
    mimeType: 'image/png',
    width: 1,
    height: 1,
  });
}

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((value: unknown) => value) as ImageGenerationError;
  expect(error).toBeInstanceOf(ImageGenerationError);
  return error.code;
}

const materializer = {
  async materialize(source: AsyncIterable<Uint8Array>) {
    for await (const _chunk of source) { /* consume */ }
    return artifact();
  },
};

describe('safe remote image resolver', () => {
  it.each([
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.1.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1',
  ])('blocks non-public address %s', (address) => {
    expect(isBlockedRemoteAddress(address)).toBe(true);
  });

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])(
    'allows public address %s',
    (address) => expect(isBlockedRemoteAddress(address)).toBe(false),
  );

  it('revalidates redirects and never connects to a private hop', async () => {
    const requestPinned = vi.fn(async () => response({
      statusCode: 302,
      headers: { location: 'http://private.test/image.png' },
    }));
    const resolver = createSafeRemoteImageResolver({
      resolveAll: async (hostname) => hostname === 'public.test'
        ? [{ address: '1.1.1.1', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }],
      requestPinned,
    });
    expect(await code(resolver.resolve({
      url: 'https://public.test/start',
      signal: new AbortController().signal,
      limits: DEFAULT_IMAGE_API_LIMITS,
      materializer,
    }))).toBe('invalid_image_request');
    expect(requestPinned).toHaveBeenCalledTimes(1);
  });

  it('rejects mixed DNS answers before the injected connect port', async () => {
    const requestPinned = vi.fn();
    const resolver = createSafeRemoteImageResolver({
      resolveAll: async () => [
        { address: '1.1.1.1', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
      requestPinned,
    });
    expect(await code(resolver.resolve({
      url: 'https://mixed.test/image.png',
      signal: new AbortController().signal,
      limits: DEFAULT_IMAGE_API_LIMITS,
      materializer,
    }))).toBe('invalid_image_request');
    expect(requestPinned).not.toHaveBeenCalled();
  });

  it('pins the approved address even if later resolver state changes', async () => {
    let current = '1.1.1.1';
    const requestPinned = vi.fn(async (input) => {
      current = '127.0.0.1';
      expect(input.address.address).toBe('1.1.1.1');
      return response();
    });
    const resolver = createSafeRemoteImageResolver({
      resolveAll: async () => [{ address: current, family: 4 }],
      requestPinned,
    });
    await expect(resolver.resolve({
      url: 'https://rebind.test/image.png',
      signal: new AbortController().signal,
      limits: DEFAULT_IMAGE_API_LIMITS,
      materializer,
    })).resolves.toMatchObject({ mimeType: 'image/png' });
    expect(requestPinned).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized declarations and chunked downloads', async () => {
    const declaredResolver = createSafeRemoteImageResolver({
      resolveAll: async () => [{ address: '1.1.1.1', family: 4 }],
      requestPinned: async () => response({
        headers: { 'content-length': String(DEFAULT_IMAGE_API_LIMITS.maxFileBytes + 1) },
      }),
    });
    expect(await code(declaredResolver.resolve({
      url: 'https://public.test/image.png',
      signal: new AbortController().signal,
      limits: DEFAULT_IMAGE_API_LIMITS,
      materializer,
    }))).toBe('image_too_large');

    const chunkedResolver = createSafeRemoteImageResolver({
      resolveAll: async () => [{ address: '1.1.1.1', family: 4 }],
      requestPinned: async () => response({ chunks: [Uint8Array.of(1), Uint8Array.of(2)] }),
    });
    expect(await code(chunkedResolver.resolve({
      url: 'https://public.test/image.png',
      signal: new AbortController().signal,
      limits: DEFAULT_IMAGE_API_LIMITS,
      materializer: {
        async materialize(source) {
          let count = 0;
          for await (const chunk of source) count += chunk.byteLength;
          if (count > 1) throw new ImageGenerationError('image_too_large');
          return artifact();
        },
      },
    }))).toBe('image_too_large');
  });

  it('maps timeout and abort while redacting URL credentials and queries', async () => {
    const waiting = createSafeRemoteImageResolver({
      resolveAll: async () => [{ address: '1.1.1.1', family: 4 }],
      requestPinned: async (input) => new Promise((_resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
      }),
    });
    expect(await code(waiting.resolve({
      url: 'https://public.test/image.png',
      signal: new AbortController().signal,
      limits: { ...DEFAULT_IMAGE_API_LIMITS, remoteTotalTimeoutMs: 10 },
      materializer,
    }))).toBe('image_generation_timeout');

    const secret = 'QUERY_SECRET_SENTINEL';
    const error = await waiting.resolve({
      url: `https://user:password@public.test/image.png?token=${secret}`,
      signal: new AbortController().signal,
      limits: DEFAULT_IMAGE_API_LIMITS,
      materializer,
    }).catch((value: unknown) => value);
    expect(JSON.stringify(serializeImageApiError(error))).not.toContain(secret);
    expect(JSON.stringify(serializeImageApiError(error))).not.toContain('password');
  });

  it('propagates an explicit caller abort through the pinned remote request', async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const requestEntered = new Promise<void>((resolve) => { entered = resolve; });
    let pinnedSignal: AbortSignal | undefined;
    const resolver = createSafeRemoteImageResolver({
      resolveAll: async () => [{ address: '1.1.1.1', family: 4 }],
      requestPinned: async (input) => {
        pinnedSignal = input.signal;
        entered();
        return new Promise((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
        });
      },
    });
    const pending = resolver.resolve({
      url: 'https://public.test/image.png',
      signal: controller.signal,
      limits: DEFAULT_IMAGE_API_LIMITS,
      materializer,
    });
    await requestEntered;
    controller.abort(new Error('REMOTE_ABORT_SECRET_SENTINEL'));
    expect(await code(pending)).toBe('request_cancelled');
    expect(pinnedSignal?.aborted).toBe(true);
  });
});
