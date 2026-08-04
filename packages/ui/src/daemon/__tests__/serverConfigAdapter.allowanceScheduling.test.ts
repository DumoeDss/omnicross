import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../adminClient', () => ({
  adminClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { adminClient } from '../adminClient';
import { createApiServiceAdapter } from '../serverConfigAdapter';

import type { OutboundApiServerConfig } from '../types-server';

const mocked = vi.mocked(adminClient);
const CONFIG: OutboundApiServerConfig = { enabled: false, networkBinding: false, endpoints: [] };
const POLICY = { enabled: true, demoteAtPercent: 80, pauseAtPercent: 98, priorityPenalty: 100 };

beforeEach(() => vi.clearAllMocks());

describe('allowance scheduling adapter', () => {
  it('persists the whole scheduling policy through the server config endpoint', async () => {
    mocked.put.mockResolvedValueOnce({ server: { ...CONFIG, allowanceScheduling: POLICY } });
    const result = await createApiServiceAdapter().updateAllowanceSchedulingConfig(POLICY);
    expect(mocked.put).toHaveBeenCalledWith('/server', { allowanceScheduling: POLICY });
    expect(result).toEqual({ success: true });
  });

  it('reads secret-free applied decisions', async () => {
    mocked.get.mockResolvedValueOnce({ scheduling: { config: POLICY, history: [] } });
    const result = await createApiServiceAdapter().getAllowanceSchedulingStatus();
    expect(mocked.get).toHaveBeenCalledWith('/accounts/allowances/scheduling');
    expect(result).toEqual({ config: POLICY, history: [] });
  });

  it('degrades an unsupported diagnostics endpoint to null', async () => {
    mocked.get.mockRejectedValueOnce(new Error('501'));
    await expect(createApiServiceAdapter().getAllowanceSchedulingStatus()).resolves.toBeNull();
  });
});
