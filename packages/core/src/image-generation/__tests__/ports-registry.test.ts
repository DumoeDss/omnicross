import { describe, expect, it, vi } from 'vitest';

import type {
  ImageCapabilities,
  ImageReferenceId,
} from '@omnicross/contracts/image-generation-types';

import type { ImageProvider } from '../ImageProvider';
import { ImageProviderRegistry } from '../ImageProviderRegistry';
import {
  emitImageTelemetry,
  InMemoryImageAsset,
  InMemoryImageReferenceStore,
  readImageAssetBytes,
} from '../ports';

const unavailable: ImageCapabilities = {
  available: false,
  reason: 'account_unverified',
  models: [],
  generate: false,
  edit: false,
  maskEdit: false,
  maxInputImages: 0,
  maxOutputImages: 0,
  streaming: false,
  maxPartialImages: 0,
  transparentBackground: false,
  flexibleSizes: false,
  outputFormats: [],
  qualityLevels: [],
  moderationModes: [],
  outputCompression: { supported: false },
  responsesTool: false,
  multiTurnEdit: false,
  supportsFileId: false,
  supportsImageUrl: false,
  resolvedAt: 0,
};

function provider(id: string): ImageProvider {
  return {
    id,
    async acquire() {
      return {
        providerId: id,
        capabilities: unavailable,
        start() {
          throw new Error('not used');
        },
        async release() {},
      };
    },
  };
}

describe('ImageProviderRegistry', () => {
  it('resolves deterministically and rejects duplicate IDs', () => {
    const registry = new ImageProviderRegistry([provider('z-provider'), provider('a-provider')]);
    expect(registry.list().map((item) => item.id)).toEqual(['a-provider', 'z-provider']);
    expect(registry.resolve('a-provider')?.id).toBe('a-provider');
    expect(() => registry.register(provider('a-provider'))).toThrow(/Duplicate image provider ID/);
  });
});

describe('image asset/reference ports', () => {
  it('opens independently readable bounded streams and propagates abort', async () => {
    const asset = new InMemoryImageAsset(new Uint8Array([1, 2, 3, 4]), {
      mimeType: 'image/png',
      width: 1,
      height: 1,
      hasAlpha: true,
    });
    expect(await readImageAssetBytes(asset, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(await readImageAssetBytes(asset, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(readImageAssetBytes(asset, 4, controller.signal)).rejects.toThrow('cancelled');
  });

  it('hides cross-tenant entries, reports same-tenant expiry, and pins active leases', async () => {
    let now = 100;
    const store = new InMemoryImageReferenceStore(() => now);
    const asset = new InMemoryImageAsset(new Uint8Array([1]), {
      mimeType: 'image/png', width: 1, height: 1,
    });
    const metadata = await store.save({
      tenantId: 'tenant-a',
      ttlMs: 10,
      artifact: asset,
      metadata: { mimeType: asset.mimeType, byteLength: 1, width: 1, height: 1 },
    });
    expect(await store.resolve('tenant-b', metadata.referenceId)).toEqual({ status: 'not_found' });
    const found = await store.resolve('tenant-a', metadata.referenceId);
    expect(found.status).toBe('found');
    now = 111;
    expect(await store.resolve('tenant-a', metadata.referenceId)).toEqual({ status: 'expired' });
    expect(await store.cleanup()).toBe(0);
    if (found.status === 'found') await found.lease.release();
    expect(await store.cleanup()).toBe(1);
  });

  it('supports tenant-scoped deletion and makes sink failures non-fatal', async () => {
    const store = new InMemoryImageReferenceStore(() => 100);
    const asset = new InMemoryImageAsset(new Uint8Array([1]), {
      mimeType: 'image/png', width: 1, height: 1,
    });
    const metadata = await store.save({
      tenantId: 'tenant-a', ttlMs: 10, artifact: asset,
      metadata: { mimeType: asset.mimeType, byteLength: 1, width: 1, height: 1 },
    });
    expect(await store.delete('tenant-b', metadata.referenceId)).toBe(false);
    expect(await store.delete('tenant-a', metadata.referenceId)).toBe(true);
    expect(await store.resolve('tenant-a', metadata.referenceId)).toEqual({ status: 'not_found' });

    const sink = { record: vi.fn(async () => { throw new Error('sink unavailable'); }) };
    await expect(emitImageTelemetry(sink, {
      requestId: 'request-safe', providerId: 'provider-safe', model: 'model-safe',
      action: 'generate', quality: 'auto', background: 'auto', outputFormat: 'png',
      streaming: false, inputCount: 0, inputBytes: 0, requestedOutputCount: 1,
      outputs: [], startedAt: 1, finishedAt: 2, terminal: 'failed',
      usageUnavailable: true,
    })).resolves.toBeUndefined();
    expect(sink.record).toHaveBeenCalledOnce();
  });

  it('treats unknown reference IDs as absent', async () => {
    const store = new InMemoryImageReferenceStore();
    expect(await store.resolve('tenant-a', 'missing' as ImageReferenceId)).toEqual({ status: 'not_found' });
  });
});
