/**
 * usageStatsLogic.filter tests — the attribute-filter option builders and the
 * billable-cycle helpers (usage-filter / usage-cycle-history).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../daemon/usagePricingAdapter', () => ({
  getUsageTotals: vi.fn(),
  getUsageByModel: vi.fn(),
  getUsageByApiKey: vi.fn(),
  getUsageTimeSeries: vi.fn(),
  getAllowanceCycles: vi.fn(),
}));

import * as adapter from '../../../../daemon/usagePricingAdapter';
import {
  buildFilterOptions,
  cycleAccountKey,
  cycleId,
  cycleRange,
  formatCycleRangeLabel,
  keyOptionsForProvider,
  loadUsageData,
} from '../usageStatsLogic';

import type { AccountAllowanceCycle, ApiKeyUsageRow } from '../../../../daemon/types-usage-pricing';

const mocked = vi.mocked(adapter);

beforeEach(() => {
  vi.clearAllMocks();
});

const keyRow = (over: Partial<ApiKeyUsageRow>): ApiKeyUsageRow => ({
  apiKeyId: 'k1',
  label: 'k1',
  providerId: 'codex',
  eventCount: 1,
  inputTokens: 1,
  outputTokens: 1,
  costUsd: 0,
  ...over,
});

describe('buildFilterOptions', () => {
  it('collects distinct providers and labelled keys, skipping the unattributed group', () => {
    const options = buildFilterOptions([
      keyRow({ apiKeyId: 'k1', label: 'codex-cli', providerId: 'codex' }),
      keyRow({ apiKeyId: null, label: 'unattributed', providerId: null }),
      keyRow({ apiKeyId: 'k2', label: 'cc', providerId: 'z-ai' }),
      keyRow({ apiKeyId: 'k1', label: 'codex-cli', providerId: 'codex' }), // dup
    ]);
    expect(options.providers).toEqual(['codex', 'z-ai']);
    // Keys sort by LABEL ('cc' < 'codex-cli'), not by id.
    expect(options.keys.map((k) => k.label)).toEqual(['cc', 'codex-cli']);
  });
});

describe('keyOptionsForProvider', () => {
  const options = buildFilterOptions([
    keyRow({ apiKeyId: 'k1', providerId: 'codex' }),
    keyRow({ apiKeyId: 'k2', providerId: 'z-ai' }),
  ]);

  it("'' keeps every key; a provider narrows to its own", () => {
    expect(keyOptionsForProvider(options, '')).toHaveLength(2);
    expect(keyOptionsForProvider(options, 'codex').map((k) => k.apiKeyId)).toEqual(['k1']);
  });
});

describe('loadUsageData filter threading', () => {
  it('passes the filter to all three adapter calls', async () => {
    mocked.getUsageTotals.mockResolvedValue({} as never);
    mocked.getUsageByModel.mockResolvedValue([] as never);
    mocked.getUsageByApiKey.mockResolvedValue([] as never);
    const range = { startTs: 0, endTs: 10 };
    await loadUsageData(range, { providerId: 'codex' });
    expect(mocked.getUsageTotals).toHaveBeenCalledWith(range, { providerId: 'codex' });
    expect(mocked.getUsageByModel).toHaveBeenCalledWith(range, { providerId: 'codex' });
    expect(mocked.getUsageByApiKey).toHaveBeenCalledWith(range, { providerId: 'codex' });
  });
});

describe('cycle helpers', () => {
  const cycle = (over: Partial<AccountAllowanceCycle> = {}): AccountAllowanceCycle => ({
    providerId: 'codex',
    accountId: 'acc-1',
    startTs: 0,
    endTs: null,
    resetsAt: null,
    kind: 'live',
    boundaryObservedAt: null,
    ...over,
  });

  it('cycleRange uses endTs when known, otherwise clamps to now', () => {
    expect(cycleRange(cycle({ startTs: 5, endTs: 9 }), 100)).toEqual({ startTs: 5, endTs: 9 });
    expect(cycleRange(cycle({ startTs: 5, endTs: null }), 100)).toEqual({ startTs: 5, endTs: 100 });
  });

  it('cycleId is stable and account-unique', () => {
    expect(cycleId(cycle({ startTs: 5 }))).toBe('codex:acc-1:5');
    expect(cycleId(cycle({ accountId: 'acc-2', startTs: 5 }))).not.toBe(cycleId(cycle({ startTs: 5 })));
  });

  it('cycleAccountKey groups per account', () => {
    expect(cycleAccountKey(cycle())).toBe('codex\0acc-1');
  });

  it('formatCycleRangeLabel marks the ongoing cycle', () => {
    const start = Date.UTC(2026, 8, 12, 9, 41); // 2026-09-12 09:41 UTC
    const end = Date.UTC(2026, 8, 19, 9, 41);
    const closed = formatCycleRangeLabel(cycle({ startTs: start, endTs: end }), 'en', 'ongoing');
    expect(closed).toContain('→');
    expect(closed).not.toContain('ongoing');
    const open = formatCycleRangeLabel(cycle({ startTs: start, endTs: null }), 'en', 'ongoing');
    expect(open.endsWith('ongoing')).toBe(true);
  });
});
