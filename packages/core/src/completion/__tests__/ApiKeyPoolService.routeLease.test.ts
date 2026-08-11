import type { ApiKeyEntry } from '@omnicross/contracts/llm-config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../ports/logger';
import { ApiKeyPoolService } from '../ApiKeyPoolService';

const rows: ApiKeyEntry[] = [
  {
    id: 'usable-key',
    providerId: 'provider-a',
    label: 'Usable',
    apiKey: 'sk-usable',
    enabled: true,
    weight: 1,
    sortOrder: 0,
  },
  {
    id: 'disabled-key',
    providerId: 'provider-a',
    label: 'Disabled',
    apiKey: 'sk-disabled',
    enabled: false,
    weight: 1,
    sortOrder: 1,
  },
];

let service: ApiKeyPoolService | undefined;

afterEach(() => {
  service?.dispose();
  service = undefined;
});

describe('ApiKeyPoolService Route Lease preflight projection', () => {
  it('distinguishes usable, known-unavailable, and missing strict key ids without returning key material', async () => {
    const loader = vi.fn(async (providerId: string) => providerId === 'provider-a' ? rows : []);
    service = new ApiKeyPoolService(
      loader,
      (value) => value,
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    );

    await expect(service.getKeyAvailability('provider-a', 'usable-key')).resolves.toBe('usable');
    await expect(service.getKeyAvailability('provider-a', 'disabled-key')).resolves.toBe('unavailable');
    await expect(service.getKeyAvailability('provider-a', 'missing-key')).resolves.toBe('not-found');
    expect(JSON.stringify(await Promise.all([
      service.getKeyAvailability('provider-a', 'usable-key'),
      service.getKeyAvailability('provider-a', 'disabled-key'),
    ]))).not.toContain('sk-');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('reports a bounded retry horizon when every enabled key is cooling down', async () => {
    vi.useFakeTimers();
    try {
      const coolingRows = rows.filter((row) => row.enabled);
      service = new ApiKeyPoolService(
        vi.fn(async () => coolingRows),
        (value) => value,
        { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      );
      await service.getKeyForSession('provider-a', 'session-a');
      await service.reportError('provider-a', 'session-a', 429);

      await expect(service.getPoolAvailability('provider-a')).resolves.toEqual({
        outcome: 'exhausted',
        retryAfterSeconds: 60,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
