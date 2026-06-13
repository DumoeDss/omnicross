/**
 * usagePricingAdapter tests — query building (incl. reserved-character id
 * encoding), envelope unwrapping, and the stateless resolve-conflicts body
 * shape (top-level ids + echoed incoming). `adminClient` is mocked so no
 * transport (or Tauri/import.meta plumbing) is exercised.
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
import {
  deletePricing,
  fetchLatestPricing,
  getPricing,
  getUsageByApiKey,
  getUsageByModel,
  getUsageTotals,
  resolvePricingConflicts,
  upsertPricing,
} from '../usagePricingAdapter';

import type { PricingEntry, PricingEntryInput } from '../types-usage-pricing';

const mocked = vi.mocked(adminClient);

const ENTRY: PricingEntry = {
  providerId: 'p1',
  modelId: 'vendor/model-a',
  inputPricePer1m: 3,
  outputPricePer1m: 15,
  cacheReadPricePer1m: 0.3,
  cacheWritePricePer1m: null,
  source: 'user',
  userEdited: true,
  editedAt: 1,
  updatedAt: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('usage queries', () => {
  it('getUsageTotals builds ?startTs&endTs and returns the bare DTO', async () => {
    const totals = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, costUsd: 0.5, costSavedByCacheUsd: 0, eventCount: 3 };
    mocked.get.mockResolvedValueOnce(totals);
    const result = await getUsageTotals({ startTs: 1000, endTs: 2000 });
    expect(mocked.get).toHaveBeenCalledWith('/usage/totals?startTs=1000&endTs=2000');
    expect(result).toBe(totals);
  });

  it('getUsageByModel / getUsageByApiKey hit their paths with the range query', async () => {
    mocked.get.mockResolvedValue([]);
    await getUsageByModel({ startTs: 5, endTs: 6 });
    expect(mocked.get).toHaveBeenCalledWith('/usage/by-model?startTs=5&endTs=6');
    await getUsageByApiKey({ startTs: 5, endTs: 6 });
    expect(mocked.get).toHaveBeenCalledWith('/usage/by-api-key?startTs=5&endTs=6');
  });
});

describe('pricing CRUD', () => {
  it('getPricing unwraps { entries }', async () => {
    mocked.get.mockResolvedValueOnce({ entries: [ENTRY] });
    expect(await getPricing()).toEqual([ENTRY]);
    expect(mocked.get).toHaveBeenCalledWith('/pricing');
  });

  it('upsertPricing PUTs the input and unwraps { entry }', async () => {
    const input: PricingEntryInput = {
      providerId: 'p1',
      modelId: 'vendor/model-a',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
      cacheReadPricePer1m: null,
    };
    mocked.put.mockResolvedValueOnce({ entry: ENTRY });
    expect(await upsertPricing(input)).toBe(ENTRY);
    expect(mocked.put).toHaveBeenCalledWith('/pricing', input);
  });

  it('deletePricing URL-encodes reserved characters in ids and unwraps { deleted }', async () => {
    mocked.delete.mockResolvedValueOnce({ deleted: true });
    expect(await deletePricing('open ai', 'vendor/model+a&b=c')).toBe(true);
    const path = mocked.delete.mock.calls[0]![0] as string;
    expect(path).toBe('/pricing?providerId=open+ai&modelId=vendor%2Fmodel%2Ba%26b%3Dc');
    // Round-trip: the daemon's parser must read the original ids back.
    const qs = new URLSearchParams(path.split('?')[1]);
    expect(qs.get('providerId')).toBe('open ai');
    expect(qs.get('modelId')).toBe('vendor/model+a&b=c');
  });

  it('deletePricing passes deleted:false through (informational, not an error)', async () => {
    mocked.delete.mockResolvedValueOnce({ deleted: false });
    expect(await deletePricing('p', 'm')).toBe(false);
  });
});

describe('fetch-latest / resolve-conflicts', () => {
  it('fetchLatestPricing POSTs and returns the result as-is', async () => {
    const result = { appliedCount: 7, conflicts: [], fetchedAt: 1, sourceUrl: 'https://example.test' };
    mocked.post.mockResolvedValueOnce(result);
    expect(await fetchLatestPricing()).toBe(result);
    expect(mocked.post).toHaveBeenCalledWith('/pricing/fetch-latest');
  });

  it('resolvePricingConflicts sends { resolutions } with top-level ids AND echoed incoming', async () => {
    const incoming: PricingEntryInput = {
      providerId: 'p1',
      modelId: 'vendor/model-a',
      inputPricePer1m: 4,
      outputPricePer1m: 16,
    };
    mocked.post.mockResolvedValueOnce({ overwrittenCount: 1, skippedCount: 0, staleCount: 0 });
    await resolvePricingConflicts([
      { providerId: 'p1', modelId: 'vendor/model-a', action: 'overwrite', incoming },
    ]);
    expect(mocked.post).toHaveBeenCalledWith('/pricing/resolve-conflicts', {
      resolutions: [
        { providerId: 'p1', modelId: 'vendor/model-a', action: 'overwrite', incoming },
      ],
    });
    // ids consistent with the echo (daemon 400s on mismatch).
    const body = mocked.post.mock.calls[0]![1] as {
      resolutions: Array<{ providerId: string; modelId: string; incoming: PricingEntryInput }>;
    };
    for (const r of body.resolutions) {
      expect(r.providerId).toBe(r.incoming.providerId);
      expect(r.modelId).toBe(r.incoming.modelId);
    }
  });
});
