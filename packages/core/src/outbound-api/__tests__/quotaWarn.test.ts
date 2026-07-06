import { afterEach, describe, expect, it } from 'vitest';

import type { KeySpend } from '../keyPolicy';
import {
  __resetQuotaWarnGuardForTests,
  computeQuotaWarnings,
  markQuotaWarnedOnce,
  WEBHOOK_QUOTA_WARN_RATIO,
} from '../quotaWarn';

afterEach(() => __resetQuotaWarnGuardForTests());

function spend(partial: Partial<KeySpend>): KeySpend {
  return {
    dailyUsd: 0,
    dailyWindowStart: 1_000,
    weeklyUsd: 0,
    weeklyWindowStart: 2_000,
    totalUsd: 0,
    ...partial,
  };
}

describe('computeQuotaWarnings', () => {
  it('warns when spend crosses the ratio but is not yet exceeded', () => {
    const out = computeQuotaWarnings({ dailyUsd: 10 }, spend({ dailyUsd: 8 }));
    expect(out).toEqual([{ scope: 'daily', limitUsd: 10, spentUsd: 8, windowStart: 1_000 }]);
  });

  it('does NOT warn below the ratio', () => {
    expect(computeQuotaWarnings({ dailyUsd: 10 }, spend({ dailyUsd: 7.9 }))).toEqual([]);
  });

  it('does NOT warn once exceeded (quotaExceeded owns that)', () => {
    expect(computeQuotaWarnings({ dailyUsd: 10 }, spend({ dailyUsd: 10 }))).toEqual([]);
    expect(computeQuotaWarnings({ dailyUsd: 10 }, spend({ dailyUsd: 12 }))).toEqual([]);
  });

  it('reports every crossing scope with its window boundary', () => {
    const out = computeQuotaWarnings(
      { dailyUsd: 10, weeklyUsd: 100, totalUsd: 1000 },
      spend({ dailyUsd: 9, weeklyUsd: 90, totalUsd: 999 }),
    );
    expect(out.map((w) => w.scope)).toEqual(['daily', 'weekly', 'total']);
    expect(out.find((w) => w.scope === 'total')?.windowStart).toBe(0);
  });

  it('honors the exported default ratio', () => {
    const limit = 10;
    const atRatio = spend({ dailyUsd: WEBHOOK_QUOTA_WARN_RATIO * limit });
    expect(computeQuotaWarnings({ dailyUsd: limit }, atRatio)).toHaveLength(1);
  });
});

describe('markQuotaWarnedOnce — per-window dedupe', () => {
  it('returns true once, then false for the same window', () => {
    expect(markQuotaWarnedOnce('k1', 'daily', 1_000)).toBe(true);
    expect(markQuotaWarnedOnce('k1', 'daily', 1_000)).toBe(false);
    expect(markQuotaWarnedOnce('k1', 'daily', 1_000)).toBe(false);
  });

  it('re-arms for a new window (different windowStart)', () => {
    expect(markQuotaWarnedOnce('k1', 'daily', 1_000)).toBe(true);
    expect(markQuotaWarnedOnce('k1', 'daily', 2_000)).toBe(true);
  });

  it('is independent per key + scope', () => {
    expect(markQuotaWarnedOnce('k1', 'daily', 1_000)).toBe(true);
    expect(markQuotaWarnedOnce('k2', 'daily', 1_000)).toBe(true);
    expect(markQuotaWarnedOnce('k1', 'weekly', 1_000)).toBe(true);
  });
});
