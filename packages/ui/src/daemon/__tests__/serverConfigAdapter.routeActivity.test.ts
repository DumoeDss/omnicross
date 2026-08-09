import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../adminClient', () => ({
  adminClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { adminClient } from '../adminClient';
import { createApiServiceAdapter } from '../serverConfigAdapter';

const mocked = vi.mocked(adminClient);

beforeEach(() => vi.clearAllMocks());

describe('account route activity adapter', () => {
  it('encodes filters and returns the metadata snapshot', async () => {
    const payload = { records: [], capacity: 300, collectedAt: 123 };
    mocked.get.mockResolvedValueOnce(payload);
    const result = await createApiServiceAdapter().queryAccountRouteActivity({
      providerId: 'codex',
      accountId: 'account/a',
      limit: 50,
    });
    expect(mocked.get).toHaveBeenCalledWith(
      '/accounts/route-activity?providerId=codex&accountId=account%2Fa&limit=50',
    );
    expect(result).toEqual({ ...payload, available: true });
  });

  it('marks an older or unreachable daemon as unavailable', async () => {
    mocked.get.mockRejectedValueOnce(new Error('404'));
    const result = await createApiServiceAdapter().queryAccountRouteActivity();
    expect(result.available).toBe(false);
    expect(result.records).toEqual([]);
    expect(result.capacity).toBe(300);
  });
});
