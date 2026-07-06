/**
 * Unit tests for the pure key-policy helpers (`outbound-key-policy`, design
 * D2/D4): expiry/activation resolution + the cost-quota decision.
 */
import { describe, expect, it } from 'vitest';

import {
  checkKeyQuota,
  checkModelAllowed,
  computeKeyExpiry,
  type KeySpend,
  type ModelRestriction,
} from '../keyPolicy';

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

describe('checkModelAllowed (#6 per-key model restriction)', () => {
  const blacklist = (models: string[]): ModelRestriction => ({ mode: 'blacklist', models });
  const allowlist = (models: string[]): ModelRestriction => ({ mode: 'allowlist', models });

  it('undefined restriction ⇒ allowed (restriction-less key path)', () => {
    expect(checkModelAllowed(undefined, 'gpt-4o')).toEqual({ allowed: true });
  });

  it('blacklist denies a listed model, naming the model', () => {
    expect(checkModelAllowed(blacklist(['gpt-4o', 'opus']), 'gpt-4o')).toEqual({
      allowed: false,
      model: 'gpt-4o',
    });
  });

  it('blacklist allows an unlisted model', () => {
    expect(checkModelAllowed(blacklist(['opus']), 'gpt-4o')).toEqual({ allowed: true });
  });

  it('allowlist permits a listed model', () => {
    expect(checkModelAllowed(allowlist(['gpt-4o']), 'gpt-4o')).toEqual({ allowed: true });
  });

  it('allowlist denies an unlisted model', () => {
    expect(checkModelAllowed(allowlist(['gpt-4o']), 'opus')).toEqual({
      allowed: false,
      model: 'opus',
    });
  });

  it('an empty allowlist denies every model (deliberate deny-all)', () => {
    expect(checkModelAllowed(allowlist([]), 'anything').allowed).toBe(false);
  });

  it('an empty blacklist allows every model', () => {
    expect(checkModelAllowed(blacklist([]), 'anything')).toEqual({ allowed: true });
  });

  it('membership is case-insensitive on the bare modelId', () => {
    expect(checkModelAllowed(blacklist(['GPT-4o']), 'gpt-4O').allowed).toBe(false);
    expect(checkModelAllowed(allowlist(['Claude-Opus']), 'claude-opus').allowed).toBe(true);
  });

  it('canonicalizes a "providerId,modelId" ref on both sides to the bare modelId', () => {
    // List entry as a full ref, resolved model as bare id → still matches.
    expect(checkModelAllowed(blacklist(['openai,gpt-4o']), 'gpt-4o').allowed).toBe(false);
    // Both as full refs → matches on the modelId part, ignoring the providerId.
    expect(checkModelAllowed(allowlist(['anthropic,opus']), 'claude,opus').allowed).toBe(true);
  });

  it('is alias-proof: it decides on the RESOLVED model id it is handed', () => {
    // The wire layer passes the RESOLVED upstream model (post kind-mapping), so a
    // client alias that maps to a blacklisted model is blocked here regardless of
    // the original client string — this fn only ever sees the resolved id.
    const resolvedFromAlias = 'opus';
    expect(checkModelAllowed(blacklist(['opus']), resolvedFromAlias).allowed).toBe(false);
  });
});
