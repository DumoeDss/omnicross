/**
 * codexUsageLimitDetection tests — marker recognition, deadline resolution
 * priority (allowance snapshot → parsed body date → default TTL), and that the
 * serving account is marked quota-exhausted (or not, when no account is known).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetSharedAccountAllowanceStoreForTests,
  getSharedAccountAllowanceStore,
} from '../../../pipeline/AccountAllowanceStore';
import {
  __resetSharedAccountHealthForTests,
  getSharedAccountHealth,
} from '../../../pipeline/SubscriptionAccountHealth';
import {
  isCodexUsageLimitError,
  markCodexUsageLimitExhaustion,
  resolveCodexQuotaDeadline,
} from '../codexUsageLimitDetection';

const ACCT = 'codex-acct-1';

const FULL_WALL_BODY = JSON.stringify({
  error: {
    message:
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 16th, 2026 3:12 PM.",
    type: 'usage_limit_reached',
  },
});

beforeEach(() => {
  __resetSharedAccountHealthForTests();
  __resetSharedAccountAllowanceStoreForTests();
});

afterEach(() => {
  __resetSharedAccountHealthForTests();
  __resetSharedAccountAllowanceStoreForTests();
});

describe('isCodexUsageLimitError', () => {
  it('recognizes the full Codex weekly-usage-limit wall body', () => {
    expect(isCodexUsageLimitError(FULL_WALL_BODY)).toBe(true);
  });

  it('recognizes each individual marker', () => {
    expect(isCodexUsageLimitError('visit chatgpt.com/codex/settings/usage now')).toBe(true);
    expect(isCodexUsageLimitError('Please purchase more credits to continue.')).toBe(true);
    expect(isCodexUsageLimitError("you've hit your usage limit for this period")).toBe(true);
  });

  it('is case-insensitive and bounded to the leading slice', () => {
    expect(isCodexUsageLimitError("YOU'VE HIT YOUR USAGE LIMIT")).toBe(true);
  });

  it('returns false for null / empty / unrelated bodies', () => {
    expect(isCodexUsageLimitError(null)).toBe(false);
    expect(isCodexUsageLimitError(undefined)).toBe(false);
    expect(isCodexUsageLimitError('')).toBe(false);
    expect(isCodexUsageLimitError('{"error":{"message":"invalid model"}}')).toBe(false);
    expect(isCodexUsageLimitError('A normal rate_limit_exceeded retry later.')).toBe(false);
  });
});

describe('resolveCodexQuotaDeadline', () => {
  it('parses the "try again at <date>" hint when no allowance snapshot exists', () => {
    const now = Date.parse('2026-08-10T00:00:00Z');
    const deadline = resolveCodexQuotaDeadline(ACCT, FULL_WALL_BODY, now);
    expect(Number.isFinite(deadline)).toBe(true);
    // The body says Aug 16 2026 — ~6 days from the fixed `now`; well past the
    // 30-min default TTL, and within a sane upper bound.
    expect(deadline).toBeGreaterThan(now + 31 * 60_000);
    expect(deadline).toBeLessThan(now + 400 * 24 * 60 * 60_000);
  });

  it('falls back to the default TTL when no date and no snapshot are available', () => {
    const now = 5_000_000;
    const deadline = resolveCodexQuotaDeadline(ACCT, '{"error":"rate limited"}', now);
    expect(deadline).toBe(now + 30 * 60_000);
  });

  it('prefers the allowance snapshot reset over the body date', () => {
    const now = 5_000_000;
    // Seed a fresh codex snapshot: window resets 1 hour from now.
    getSharedAccountAllowanceStore().recordCodexHeaders(
      ACCT,
      { 'x-codex-primary-reset-after-seconds': '3600', 'x-codex-primary-used-percent': '100' },
      now,
    );
    const deadline = resolveCodexQuotaDeadline(ACCT, FULL_WALL_BODY, now);
    // Snapshot wins: ~1h from now (3600s), NOT the body's ~6-days date.
    expect(deadline).toBeGreaterThan(now + 3500_000);
    expect(deadline).toBeLessThan(now + 3700_000);
  });

  it('treats a parsed date in the past as unusable (falls through to the TTL)', () => {
    const now = Date.parse('2027-01-01T00:00:00Z'); // body's "Aug 16, 2026" is now in the past
    const deadline = resolveCodexQuotaDeadline(ACCT, FULL_WALL_BODY, now);
    expect(deadline).toBe(now + 30 * 60_000);
  });
});

describe('markCodexUsageLimitExhaustion', () => {
  it('marks the known account quota-exhausted on the shared health tracker', () => {
    const now = Date.parse('2026-08-10T00:00:00Z');
    markCodexUsageLimitExhaustion(ACCT, FULL_WALL_BODY, now);
    const status = getSharedAccountHealth().getStatus('codex', ACCT);
    expect(status.state).toBe('quota_exhausted');
    expect(status.cooldownUntil).toBeGreaterThan(now);
    expect(getSharedAccountHealth().isSchedulable('codex', ACCT)).toBe(false);
  });

  it('is a no-op when no account id is known (BYO / unreported selection)', () => {
    markCodexUsageLimitExhaustion(undefined, FULL_WALL_BODY);
    expect(getSharedAccountHealth().getStatus('codex', ACCT).state).toBe('healthy');
    expect(getSharedAccountHealth().isSchedulable('codex', ACCT)).toBe(true);
  });
});
