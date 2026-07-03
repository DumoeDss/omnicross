/**
 * usageStatsLogic dashboard-helper tests — `autoBucketForRange` threshold
 * boundaries (2d / 62d) and `modelShares` (cost-share, zero-cost token
 * fallback, empty rows, cost-desc order).
 */
import { describe, expect, it } from 'vitest';

import { autoBucketForRange, modelShares } from '../usageStatsLogic';

import type { ModelUsageRow } from '../../../../daemon/types-usage-pricing';

const DAY = 86_400_000;

function row(model: string, costUsd: number, inputTokens = 0, outputTokens = 0): ModelUsageRow {
  return {
    providerId: 'p',
    model,
    eventCount: 1,
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd,
    costSavedByCacheUsd: 0,
    unpriced: costUsd === 0,
  };
}

describe('autoBucketForRange', () => {
  it('≤ 2 days → hour (inclusive boundary)', () => {
    expect(autoBucketForRange({ startTs: 0, endTs: DAY })).toBe('hour');
    expect(autoBucketForRange({ startTs: 0, endTs: 2 * DAY })).toBe('hour');
  });

  it('just past 2 days → day', () => {
    expect(autoBucketForRange({ startTs: 0, endTs: 2 * DAY + 1 })).toBe('day');
  });

  it('≤ 62 days → day (inclusive boundary)', () => {
    expect(autoBucketForRange({ startTs: 0, endTs: 62 * DAY })).toBe('day');
  });

  it('just past 62 days → month', () => {
    expect(autoBucketForRange({ startTs: 0, endTs: 62 * DAY + 1 })).toBe('month');
    expect(autoBucketForRange({ startTs: 0, endTs: 365 * DAY })).toBe('month');
  });
});

describe('modelShares', () => {
  it('computes cost-share fractions summing to ≈1 and sorts by cost desc', () => {
    const shares = modelShares([row('a', 1), row('b', 3)]);
    expect(shares.map((s) => s.model)).toEqual(['b', 'a']);
    expect(shares[0]!.share).toBeCloseTo(0.75, 6);
    expect(shares[1]!.share).toBeCloseTo(0.25, 6);
    expect(shares.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 6);
  });

  it('falls back to input+output token share when total cost is 0', () => {
    const shares = modelShares([row('a', 0, 30, 10), row('b', 0, 10, 0)]);
    // a: 40 tokens, b: 10 tokens → 0.8 / 0.2
    const byModel = Object.fromEntries(shares.map((s) => [s.model, s.share]));
    expect(byModel.a).toBeCloseTo(0.8, 6);
    expect(byModel.b).toBeCloseTo(0.2, 6);
    expect(shares.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 6);
  });

  it('all-zero cost and tokens → every share 0', () => {
    const shares = modelShares([row('a', 0), row('b', 0)]);
    expect(shares.every((s) => s.share === 0)).toBe(true);
  });

  it('empty rows → empty array', () => {
    expect(modelShares([])).toEqual([]);
  });
});
