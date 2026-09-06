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
  parseCodexUsageLimitErrorPayload,
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
    expect(deadline).toBe(now + 5 * 60_000);
  });

  it('prefers the allowance snapshot reset over the body date (when the window is exhausted)', () => {
    const now = 5_000_000;
    // Seed a fresh codex snapshot: window resets 1 hour from now, used 100%.
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

  it('does NOT borrow a low-usage window reset (a transient 429 gets the short default)', () => {
    const now = 5_000_000;
    // Window resets 1h from now but is only 10% used → not the weekly wall.
    getSharedAccountAllowanceStore().recordCodexHeaders(
      ACCT,
      { 'x-codex-primary-reset-after-seconds': '3600', 'x-codex-primary-used-percent': '10' },
      now,
    );
    const deadline = resolveCodexQuotaDeadline(ACCT, '{"error":"rate limited"}', now);
    expect(deadline).toBe(now + 5 * 60_000); // default TTL, not the 1h reset
  });

  it('treats a parsed date in the past as unusable (falls through to the TTL)', () => {
    const now = Date.parse('2027-01-01T00:00:00Z'); // body's "Aug 16, 2026" is now in the past
    const deadline = resolveCodexQuotaDeadline(ACCT, FULL_WALL_BODY, now);
    expect(deadline).toBe(now + 5 * 60_000);
  });
});

describe('markCodexUsageLimitExhaustion', () => {
  it('marks the known account quota-exhausted on the shared health tracker', () => {
    const now = Date.parse('2026-08-10T00:00:00Z');
    markCodexUsageLimitExhaustion(ACCT, FULL_WALL_BODY, now);
    // Read back at the SAME fixed `now` — the mark's deadline (parsed from the
    // body's Aug 16 hint) is only ~6 days out, so evaluating at the real clock
    // would rot this test once that date passes.
    const status = getSharedAccountHealth().getStatus('codex', ACCT, now);
    expect(status.state).toBe('quota_exhausted');
    expect(status.cooldownUntil).toBeGreaterThan(now);
    expect(getSharedAccountHealth().isSchedulable('codex', ACCT, now)).toBe(false);
  });

  it('is a no-op when no account id is known (BYO / unreported selection)', () => {
    markCodexUsageLimitExhaustion(undefined, FULL_WALL_BODY);
    expect(getSharedAccountHealth().getStatus('codex', ACCT).state).toBe('healthy');
    expect(getSharedAccountHealth().isSchedulable('codex', ACCT)).toBe(true);
  });
});

describe('structured usage-limit error payloads', () => {
  it('extracts code, epoch-second resets_at, and plan_type from a JSON body', () => {
    const payload = parseCodexUsageLimitErrorPayload(
      JSON.stringify({ error: { code: 'usage_limit_reached', resets_at: 1785991200, plan_type: 'pro' } }),
    );
    expect(payload).toEqual({ code: 'usage_limit_reached', resetsAtMs: 1_785_991_200_000, planType: 'pro' });
  });

  it('recognizes the family of meter error codes and rejects unrelated JSON', () => {
    expect(parseCodexUsageLimitErrorPayload('{"error":{"code":"usage_not_included"}}')?.code)
      .toBe('usage_not_included');
    expect(parseCodexUsageLimitErrorPayload('{"error":{"code":"rate_limit_exceeded"}}')?.code)
      .toBe('rate_limit_exceeded');
    expect(parseCodexUsageLimitErrorPayload('{"error":{"code":"server_is_overloaded"}}')).toBeNull();
    expect(parseCodexUsageLimitErrorPayload('plain text body')).toBeNull();
  });

  it('classifies a structured body as the usage wall even without English markers', () => {
    // A localized body carrying only the machine code still matches.
    const localized = JSON.stringify({ error: { code: 'usage_limit_reached', message: '上限に達しました' } });
    expect(isCodexUsageLimitError(localized)).toBe(true);
    // rate_limit_exceeded is a transient meter error, not the wall.
    expect(isCodexUsageLimitError(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }))).toBe(false);
  });

  it('prefers the structured resets_at over the "try again at" text', () => {
    const now = Date.parse('2026-08-10T00:00:00Z');
    const resetsAtMs = now + 3 * 24 * 3600 * 1000;
    const body = JSON.stringify({
      error: { code: 'usage_limit_reached', resets_at: resetsAtMs / 1000, plan_type: 'team' },
    });
    expect(resolveCodexQuotaDeadline(ACCT, body, now)).toBe(resetsAtMs);
  });
});
