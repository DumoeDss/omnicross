/**
 * serverConfigAdapter queue-mutation tests — the two additions from
 * omnicross-uqc-ui: `setKeyMaxConcurrency` (POST /keys/:id/max-concurrency, null
 * clears, ok:false → not found) and `updateQueueConfig` (PUT /server with just
 * the changed segment, reusing applyServerPut). `adminClient` is mocked so no
 * transport is exercised.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../adminClient', () => ({
  adminClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

import { adminClient } from '../adminClient';
import { createApiServiceAdapter } from '../serverConfigAdapter';

import type { OutboundApiServerConfig } from '../types-server';

const mocked = vi.mocked(adminClient);

const CONFIG: OutboundApiServerConfig = {
  enabled: false,
  networkBinding: false,
  endpoints: [],
  userMessageQueue: { enabled: false, delayMs: 200, waitTimeoutMs: 60000 },
  concurrencyQueue: { maxQueueSizeFactor: 2, minQueueSize: 4, waitTimeoutMs: 60000 },
};

const IMAGES: NonNullable<OutboundApiServerConfig['images']> = {
  enabled: false,
  provider: 'codex-subscription',
  defaultModel: 'gpt-image-2',
  modelAliases: {},
  account: { fallback: 'strict' },
  queue: {
    maxConcurrentJobsPerAccount: 1,
    maxQueuedJobs: 20,
    queueTimeoutMs: 120_000,
    generationTimeoutMs: 180_000,
  },
  temporary: {
    maxActiveScopes: 64,
    maxTotalBytes: 1024 ** 3,
    maxTenantBytes: 256 * 1024 ** 2,
    staleAfterMs: 3_600_000,
    cleanupIntervalMs: 300_000,
  },
  limits: {
    maxJsonBytes: 1024 ** 2,
    maxMultipartBytes: 64 * 1024 ** 2,
    maxFileBytes: 50 * 1024 ** 2,
    maxTotalInputBytes: 64 * 1024 ** 2,
    maxFiles: 17,
    maxFields: 32,
    maxParts: 49,
    maxHeaderPairs: 64,
    maxFieldNameBytes: 128,
    maxFieldValueBytes: 32 * 1024,
    maxPixels: 8_294_400,
    maxRawBytes: 8_294_400 * 4,
    maxOutputBytes: 50 * 1024 ** 2,
    maxTotalOutputBytes: 100 * 1024 ** 2,
    maxSpoolBytes: 140 * 1024 ** 2,
    maxRedirects: 5,
    maxRemoteUrlBytes: 8 * 1024,
    maxRemoteHeaderBytes: 32 * 1024,
    remoteConnectTimeoutMs: 10_000,
    remoteTotalTimeoutMs: 30_000,
  },
  references: {
    ttlMs: 86_400_000,
    maxArtifactBytes: 50 * 1024 ** 2,
    maxTotalBytes: 4 * 1024 ** 3,
    maxTenantBytes: 1024 ** 3,
    maxEntries: 10_000,
    maxCalls: 20_000,
    maxResponses: 10_000,
    maxTombstones: 20_000,
    tombstoneTtlMs: 86_400_000,
    cleanupIntervalMs: 300_000,
  },
  remote: { enabled: false },
  evidenceTtlMs: 86_400_000,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('setKeyMaxConcurrency', () => {
  it('POSTs the numeric limit and succeeds on ok:true', async () => {
    mocked.post.mockResolvedValueOnce({ ok: true, maxConcurrency: 5 });
    const adapter = createApiServiceAdapter();
    const result = await adapter.setKeyMaxConcurrency('k1', 5);
    expect(mocked.post).toHaveBeenCalledWith('/keys/k1/max-concurrency', { maxConcurrency: 5 });
    expect(result).toEqual({ success: true });
  });

  it('POSTs null to clear the limit (unlimited)', async () => {
    mocked.post.mockResolvedValueOnce({ ok: true, maxConcurrency: null });
    const adapter = createApiServiceAdapter();
    const result = await adapter.setKeyMaxConcurrency('k1', null);
    expect(mocked.post).toHaveBeenCalledWith('/keys/k1/max-concurrency', { maxConcurrency: null });
    expect(result.success).toBe(true);
  });

  it('maps ok:false to a "key not found" failure (never fake success)', async () => {
    mocked.post.mockResolvedValueOnce({ ok: false });
    const adapter = createApiServiceAdapter();
    const result = await adapter.setKeyMaxConcurrency('missing', 3);
    expect(result).toEqual({ success: false, message: 'key not found' });
  });

  it('surfaces a transport error honestly', async () => {
    mocked.post.mockRejectedValueOnce(new Error('boom'));
    const adapter = createApiServiceAdapter();
    const result = await adapter.setKeyMaxConcurrency('k1', 3);
    expect(result).toEqual({ success: false, message: 'boom' });
  });
});

describe('updateQueueConfig', () => {
  it('PUTs only the changed serial segment and succeeds', async () => {
    mocked.put.mockResolvedValueOnce({ server: CONFIG });
    const adapter = createApiServiceAdapter();
    const patch = { userMessageQueue: { enabled: true, delayMs: 200, waitTimeoutMs: 60000 } };
    const result = await adapter.updateQueueConfig(patch);
    expect(mocked.put).toHaveBeenCalledWith('/server', patch);
    expect(result).toEqual({ success: true });
  });

  it('PUTs only the concurrency segment', async () => {
    mocked.put.mockResolvedValueOnce({ server: CONFIG });
    const adapter = createApiServiceAdapter();
    const patch = { concurrencyQueue: { maxQueueSizeFactor: 3, minQueueSize: 4, waitTimeoutMs: 60000 } };
    await adapter.updateQueueConfig(patch);
    expect(mocked.put).toHaveBeenCalledWith('/server', patch);
  });

  it('surfaces a transport error honestly', async () => {
    mocked.put.mockRejectedValueOnce(new Error('net down'));
    const adapter = createApiServiceAdapter();
    const result = await adapter.updateQueueConfig({
      concurrencyQueue: { maxQueueSizeFactor: 2, minQueueSize: 4, waitTimeoutMs: 60000 },
    });
    expect(result).toEqual({ success: false, message: 'net down' });
  });
});

describe('Images permission/config mutations', () => {
  it('reads capability through the dedicated non-consuming admin endpoint', async () => {
    const capability = {
      configured: { enabled: true },
      effective: { available: false, reason: 'evidence_unavailable' },
    };
    mocked.get.mockResolvedValueOnce(capability);
    const result = await createApiServiceAdapter().getImagesCapability();
    expect(mocked.get).toHaveBeenCalledWith('/images/capabilities');
    expect(result).toBe(capability);
    expect(mocked.post).not.toHaveBeenCalled();
    expect(mocked.put).not.toHaveBeenCalled();
  });

  it('maps an unavailable capability endpoint to null', async () => {
    mocked.get.mockRejectedValueOnce(new Error('older daemon'));
    await expect(createApiServiceAdapter().getImagesCapability()).resolves.toBeNull();
  });

  it('posts the exact permission list without collapsing Images into a text endpoint', async () => {
    mocked.post.mockResolvedValueOnce({ ok: true, allowedEndpoints: ['responses', 'images'] });
    const adapter = createApiServiceAdapter();
    const result = await adapter.setKeyPermissions('k1', ['responses', 'images']);
    expect(mocked.post).toHaveBeenCalledWith('/keys/k1/permissions', {
      permissions: ['responses', 'images'],
    });
    expect(result).toEqual({ success: true });
  });

  it('never reports a failed permission mutation as success', async () => {
    mocked.post.mockResolvedValueOnce({ ok: false });
    const result = await createApiServiceAdapter().setKeyPermissions('k1', ['images']);
    expect(result).toEqual({ success: false, message: 'key not found or revoked' });
  });

  it('puts the complete Images segment and accepts only the normalized server echo', async () => {
    mocked.put.mockResolvedValueOnce({ server: { ...CONFIG, images: IMAGES } });
    const result = await createApiServiceAdapter().updateImagesConfig(IMAGES);
    expect(mocked.put).toHaveBeenCalledWith('/server', { images: IMAGES });
    expect(result).toEqual({ success: true });
  });

  it('strips the admin-only storage marker before strict config writes', async () => {
    const config = {
      ...IMAGES,
      references: { ...IMAGES.references, storageRootConfigured: true },
    };
    mocked.put.mockResolvedValueOnce({ server: { ...CONFIG, images: config } });
    const result = await createApiServiceAdapter().updateImagesConfig(config);
    expect(mocked.put).toHaveBeenCalledWith('/server', {
      images: { ...config, references: IMAGES.references },
    });
    expect(result).toEqual({ success: true });
  });

  it('never reports a failed Images config write as success', async () => {
    mocked.put.mockRejectedValueOnce(new Error('validation failed'));
    const result = await createApiServiceAdapter().updateImagesConfig(IMAGES);
    expect(result).toEqual({ success: false, message: 'validation failed' });
  });
});
