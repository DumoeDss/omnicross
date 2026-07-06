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

  it('propagates an incomplete-model-config envelope (not fake success)', async () => {
    const missing = [{ endpoint: 'messages' as const, missingKinds: ['fable'] }];
    mocked.put.mockResolvedValueOnce({
      server: CONFIG,
      error: { code: 'incomplete-model-config', missing },
    });
    const adapter = createApiServiceAdapter();
    const result = await adapter.updateQueueConfig({
      userMessageQueue: { enabled: true, delayMs: 200, waitTimeoutMs: 60000 },
    });
    expect(result).toEqual({ success: false, message: 'incomplete-model-config', missing });
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
