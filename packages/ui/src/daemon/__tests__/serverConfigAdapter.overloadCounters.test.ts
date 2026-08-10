import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../adminClient', () => ({
  adminClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { adminClient } from '../adminClient';
import { createApiServiceAdapter } from '../serverConfigAdapter';

const mocked = vi.mocked(adminClient);

beforeEach(() => vi.clearAllMocks());

describe('overload counters adapter', () => {
  it('encodes filters and returns the tally snapshot', async () => {
    const payload = { entries: [{ providerId: 'codex', accountId: 'a', count: 3 }], collectedAt: 123 };
    mocked.get.mockResolvedValueOnce(payload);
    const result = await createApiServiceAdapter().queryOverloadCounters({
      providerId: 'codex',
      accountId: 'account/a',
    });
    expect(mocked.get).toHaveBeenCalledWith(
      '/accounts/overload-counters?providerId=codex&accountId=account%2Fa',
    );
    expect(result).toEqual({ ...payload, available: true });
  });

  it('marks an older or unreachable daemon as unavailable with an empty entry list', async () => {
    mocked.get.mockRejectedValueOnce(new Error('404'));
    const result = await createApiServiceAdapter().queryOverloadCounters();
    expect(result.available).toBe(false);
    expect(result.entries).toEqual([]);
  });
});
