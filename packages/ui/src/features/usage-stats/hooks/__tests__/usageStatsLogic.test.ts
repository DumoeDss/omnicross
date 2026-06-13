/**
 * usageStatsLogic tests — preset/custom range computation (endTs exclusive),
 * the parallel loader's single-failure semantics, and unattributed grouping
 * keyed off `apiKeyId === null` (label string not trusted).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../daemon/usagePricingAdapter', () => ({
  getUsageTotals: vi.fn(),
  getUsageByModel: vi.fn(),
  getUsageByApiKey: vi.fn(),
}));

import * as adapter from '../../../../daemon/usagePricingAdapter';
import {
  computeCustomRange,
  computePresetRange,
  loadUsageData,
  partitionApiKeyRows,
  sortByCostDesc,
} from '../usageStatsLogic';

import type { ApiKeyUsageRow, ModelUsageRow } from '../../../../daemon/types-usage-pricing';

const mocked = vi.mocked(adapter);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computePresetRange', () => {
  // Local noon — keeps start-of-day math unambiguous regardless of TZ.
  const now = new Date(2026, 5, 13, 12, 0, 0, 0).getTime();
  const todayStart = new Date(2026, 5, 13, 0, 0, 0, 0).getTime();

  it('today = [local midnight, now)', () => {
    expect(computePresetRange('today', now)).toEqual({ startTs: todayStart, endTs: now });
  });

  it('7d starts at local midnight 6 CALENDAR days back, endTs exclusive = now', () => {
    const r = computePresetRange('7d', now);
    // Calendar expectation (Date day-field rollover), NOT now - 6*24h: the two
    // agree here but diverge across a DST transition.
    expect(r).toEqual({ startTs: new Date(2026, 5, 7).getTime(), endTs: now });
  });

  it('30d starts at local midnight 29 calendar days back', () => {
    const r = computePresetRange('30d', now);
    expect(r).toEqual({ startTs: new Date(2026, 4, 15).getTime(), endTs: now });
  });

  it('preset starts land EXACTLY on local midnight even across month boundaries', () => {
    // 2026-07-02 → 30d reaches back into June.
    const julyNow = new Date(2026, 6, 2, 9, 30).getTime();
    const r = computePresetRange('30d', julyNow);
    const start = new Date(r.startTs);
    expect([start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()]).toEqual([0, 0, 0, 0]);
    expect(start.getTime()).toBe(new Date(2026, 5, 3).getTime());
  });
});

describe('computeCustomRange', () => {
  it('end day is user-inclusive (endTs = start of NEXT day, exclusive)', () => {
    const r = computeCustomRange('2026-06-01', '2026-06-02');
    expect(r).not.toBeNull();
    expect(r!.startTs).toBe(new Date(2026, 5, 1).getTime());
    expect(r!.endTs).toBe(new Date(2026, 5, 3).getTime());
  });

  it('single-day range is valid (from == to) and endTs is the NEXT calendar midnight', () => {
    const r = computeCustomRange('2026-06-01', '2026-06-01');
    expect(r!.startTs).toBe(new Date(2026, 5, 1).getTime());
    // Calendar rollover, not startTs + 24h (DST-safe).
    expect(r!.endTs).toBe(new Date(2026, 5, 2).getTime());
  });

  it('end day spanning a month boundary rolls over by calendar', () => {
    const r = computeCustomRange('2026-06-29', '2026-06-30');
    expect(r!.endTs).toBe(new Date(2026, 6, 1).getTime());
  });

  it('returns null for missing, invalid, or inverted inputs', () => {
    expect(computeCustomRange('', '2026-06-01')).toBeNull();
    expect(computeCustomRange('2026-06-01', '')).toBeNull();
    expect(computeCustomRange('not-a-date', '2026-06-01')).toBeNull();
    expect(computeCustomRange('2026-06-05', '2026-06-01')).toBeNull();
  });
});

describe('loadUsageData', () => {
  const range = { startTs: 1, endTs: 2 };

  it('loads all three views in parallel for the same range', async () => {
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, costUsd: 0, costSavedByCacheUsd: 0, eventCount: 0 };
    mocked.getUsageTotals.mockResolvedValueOnce(totals);
    mocked.getUsageByModel.mockResolvedValueOnce([]);
    mocked.getUsageByApiKey.mockResolvedValueOnce([]);
    const data = await loadUsageData(range);
    expect(data).toEqual({ totals, byModel: [], byApiKey: [] });
    expect(mocked.getUsageTotals).toHaveBeenCalledWith(range);
    expect(mocked.getUsageByModel).toHaveBeenCalledWith(range);
    expect(mocked.getUsageByApiKey).toHaveBeenCalledWith(range);
  });

  it('any single endpoint failure fails the whole load (no silent partials)', async () => {
    mocked.getUsageTotals.mockResolvedValueOnce({} as never);
    mocked.getUsageByModel.mockRejectedValueOnce(new Error('boom'));
    mocked.getUsageByApiKey.mockResolvedValueOnce([]);
    await expect(loadUsageData(range)).rejects.toThrow('boom');
  });
});

describe('partitionApiKeyRows', () => {
  const row = (apiKeyId: string | null, label: string): ApiKeyUsageRow => ({
    apiKeyId,
    label,
    providerId: apiKeyId ? 'p' : null,
    eventCount: 1,
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0.1,
  });

  it('keys the unattributed group off apiKeyId === null, whatever the label says', () => {
    const rows = [row('k1', 'My key'), row(null, 'some-daemon-sentinel'), row('k2', 'unattributed')];
    const { attributed, unattributed } = partitionApiKeyRows(rows);
    expect(attributed.map((r) => r.apiKeyId)).toEqual(['k1', 'k2']);
    expect(unattributed?.apiKeyId).toBeNull();
    expect(unattributed?.label).toBe('some-daemon-sentinel');
  });

  it('all-unattributed data yields zero attributed rows and the group (expected state)', () => {
    const { attributed, unattributed } = partitionApiKeyRows([row(null, 'unattributed')]);
    expect(attributed).toEqual([]);
    expect(unattributed).not.toBeNull();
  });

  it('no null row → unattributed is null', () => {
    expect(partitionApiKeyRows([row('k1', 'a')]).unattributed).toBeNull();
  });
});

describe('sortByCostDesc', () => {
  it('orders by costUsd descending without mutating the input', () => {
    const mk = (cost: number): ModelUsageRow => ({
      providerId: 'p',
      model: `m${cost}`,
      eventCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: cost,
      costSavedByCacheUsd: 0,
      unpriced: false,
    });
    const input = [mk(1), mk(3), mk(2)];
    const sorted = sortByCostDesc(input);
    expect(sorted.map((r) => r.costUsd)).toEqual([3, 2, 1]);
    expect(input.map((r) => r.costUsd)).toEqual([1, 3, 2]);
  });
});
