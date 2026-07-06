/**
 * Unit tests for the pure key-policy helpers (`outbound-key-policy`, design
 * D2/D4): expiry/activation resolution + the cost-quota decision.
 */
import { describe, expect, it } from 'vitest';

import { checkKeyQuota, computeKeyExpiry, type KeySpend } from '../keyPolicy';

const DAY_MS = 86_400_000;

describe('computeKeyExpiry', () => {
  it('a key with no expiry never expires', () => {
    expect(computeKeyExpiry({}, 1_000)).toEqual({ expired: false });
  });

  it('fixed mode: expired at/after expiresAt', () => {
    expect(computeKeyExpiry({ expiresAt: 1_000 }, 999)).toEqual({
      expired: false,
      effectiveExpiresAt: 1_000,
    });
    expect(computeKeyExpiry({ expiresAt: 1_000 }, 1_000).expired).toBe(true);
    expect(computeKeyExpiry({ expiresAt: 1_000 }, 5_000).expired).toBe(true);
  });

  it('activation mode: not expired + needsActivation while activatedAt is null', () => {
    const r = computeKeyExpiry({ activationMode: 'activation', activationDays: 30 }, 10_000);
    expect(r.expired).toBe(false);
    expect(r.needsActivation).toBe(true);
  });

  it('activation mode: expires activationDays after activatedAt', () => {
    const row = { activationMode: 'activation' as const, activationDays: 7, activatedAt: 1_000 };
    expect(computeKeyExpiry(row, 1_000 + 3 * DAY_MS).expired).toBe(false);
    expect(computeKeyExpiry(row, 1_000 + 7 * DAY_MS).expired).toBe(true);
  });

  it('activation mode: null activationDays never expires once activated', () => {
    const row = { activationMode: 'activation' as const, activatedAt: 1_000 };
    expect(computeKeyExpiry(row, 1_000 + 999 * DAY_MS).expired).toBe(false);
  });
});

const spend = (over: Partial<KeySpend>): KeySpend => ({
  dailyUsd: 0,
  dailyWindowStart: 0,
  weeklyUsd: 0,
  weeklyWindowStart: 0,
  totalUsd: 0,
  ...over,
});

describe('checkKeyQuota', () => {
  it('allows when no limits are configured', () => {
    expect(checkKeyQuota(undefined, spend({ totalUsd: 999 }))).toEqual({ allowed: true });
  });

  it('allows while under every configured limit', () => {
    expect(
      checkKeyQuota({ dailyUsd: 5, totalUsd: 100 }, spend({ dailyUsd: 4, totalUsd: 40 })),
    ).toEqual({ allowed: true });
  });

  it('denies with 402 scope=daily at/over the daily limit', () => {
    expect(checkKeyQuota({ dailyUsd: 5 }, spend({ dailyUsd: 5 }))).toEqual({
      allowed: false,
      scope: 'daily',
      limitUsd: 5,
      spentUsd: 5,
    });
  });

  it('denies with scope=weekly + scope=total', () => {
    expect(checkKeyQuota({ weeklyUsd: 10 }, spend({ weeklyUsd: 12 })).allowed).toBe(false);
    expect(checkKeyQuota({ totalUsd: 100 }, spend({ totalUsd: 100 }))).toEqual({
      allowed: false,
      scope: 'total',
      limitUsd: 100,
      spentUsd: 100,
    });
  });
});
