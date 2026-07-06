/**
 * SubscriptionAccountHealth tests (subscription-account-health, task 1.8) — the
 * in-memory state machine: 429-reset marking + expiry, bare-429 no-op, 529
 * cooldown (+ gating), 403-ban permanence, plain-403 / 401 / 5xx / thrown
 * transient, non-429-4xx neutral, 2xx clears (not block), lazy clear, the
 * recovery transition + hook, per-provider reset resolution, and config retune.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  resolveResetSeconds,
  SubscriptionAccountHealth,
} from '../SubscriptionAccountHealth';

const P = 'claude';
const A = 'acct-A';

/** A tracker with a mutable clock for deterministic timer expiry. */
function makeTracker(overrides = {}): { health: SubscriptionAccountHealth; setNow: (n: number) => void } {
  let clock = 1_000_000;
  const health = new SubscriptionAccountHealth({ now: () => clock, ...overrides });
  return { health, setNow: (n) => { clock = n; } };
}

describe('SubscriptionAccountHealth — 429 reset-header cooldown', () => {
  it('marks rate-limited until the reset instant, then self-heals lazily', () => {
    const { health, setNow } = makeTracker();
    // reset header = epoch SECONDS in the future (now=1_000_000 ms ⇒ 1000 s).
    health.recordUpstreamOutcome(P, A, { status: 429, resetHeaderSeconds: 2000 });
    expect(health.isSchedulable(P, A)).toBe(false);
    expect(health.getStatus(P, A).state).toBe('rate_limited');
    expect(health.getStatus(P, A).cooldownUntil).toBe(2000 * 1000);

    setNow(2000 * 1000); // wall clock reaches the reset → schedulable again on read
    expect(health.isSchedulable(P, A)).toBe(true);
  });

  it('does NOT mark a bare 429 with no resolvable reset (transient overflow)', () => {
    const { health } = makeTracker();
    health.recordUpstreamOutcome(P, A, { status: 429 });
    expect(health.isSchedulable(P, A)).toBe(true);
    expect(health.getStatus(P, A).state).toBe('healthy');
  });

  it('uses retryAfterSeconds as a now-relative fallback (non-claude drivers)', () => {
    const { health } = makeTracker();
    health.recordUpstreamOutcome('codex', A, { status: 429, retryAfterSeconds: 30 });
    expect(health.isSchedulable('codex', A)).toBe(false);
    expect(health.getStatus('codex', A).cooldownUntil).toBe(1_000_000 + 30_000);
  });
});

describe('SubscriptionAccountHealth — 529 overload', () => {
  it('places the account in overload cooldown when enabled (default ON)', () => {
    const { health } = makeTracker({ overloadTtlMs: 600_000 });
    health.recordUpstreamOutcome(P, A, { status: 529 });
    expect(health.isSchedulable(P, A)).toBe(false);
    expect(health.getStatus(P, A).state).toBe('overloaded');
    expect(health.getStatus(P, A).cooldownUntil).toBe(1_000_000 + 600_000);
  });

  it('does NOT mark a 529 when overload handling is disabled', () => {
    const { health } = makeTracker({ overloadEnabled: false });
    health.recordUpstreamOutcome(P, A, { status: 529 });
    expect(health.isSchedulable(P, A)).toBe(true);
  });
});

describe('SubscriptionAccountHealth — unauthorized / blocked', () => {
  it('403-ban body blocks permanently (a later 2xx does NOT clear it)', () => {
    const { health } = makeTracker();
    health.recordUpstreamOutcome(P, A, {
      status: 403,
      bodyText: 'This organization has been disabled by Anthropic.',
    });
    expect(health.isSchedulable(P, A)).toBe(false);
    expect(health.getStatus(P, A).state).toBe('blocked');

    health.recordUpstreamOutcome(P, A, { status: 200 });
    expect(health.isSchedulable(P, A)).toBe(false); // still blocked
    expect(health.getStatus(P, A).state).toBe('blocked');
  });

  it('plain 403 / final-401 / 5xx / thrown are transient and self-heal', () => {
    for (const status of [403, 401, 500, null] as const) {
      const { health, setNow } = makeTracker();
      health.recordUpstreamOutcome(P, A, { status });
      expect(health.isSchedulable(P, A)).toBe(false);
      expect(health.getStatus(P, A).state).toBe('transient');
      setNow(1_000_000 + 40 * 60_000); // past both 30m and 5m TTLs
      expect(health.isSchedulable(P, A)).toBe(true);
    }
  });

  it('a non-429 4xx is NEUTRAL — never marked', () => {
    const { health } = makeTracker();
    for (const status of [400, 404, 422]) {
      health.recordUpstreamOutcome(P, A, { status });
    }
    expect(health.isSchedulable(P, A)).toBe(true);
    expect(health.getStatus(P, A).state).toBe('healthy');
  });
});

describe('SubscriptionAccountHealth — 2xx recovery', () => {
  it('clears a rate limit + transient state on success', () => {
    const { health } = makeTracker();
    health.recordUpstreamOutcome(P, A, { status: 429, resetHeaderSeconds: 5000 });
    expect(health.isSchedulable(P, A)).toBe(false);
    health.recordUpstreamOutcome(P, A, { status: 200 });
    expect(health.isSchedulable(P, A)).toBe(true);
    expect(health.getStatus(P, A).state).toBe('healthy');
  });

  it('emits a recovery signal on the 2xx-clear edge (busy account) — but not for an already-healthy 2xx', () => {
    const { health } = makeTracker();
    const seen: string[] = [];
    health.onRecovered((e) => seen.push(e.accountId));

    // A 2xx on an already-healthy account is NOT a recovery edge.
    health.recordUpstreamOutcome(P, A, { status: 200 });
    expect(seen).toEqual([]);

    // Unhealthy → 2xx clears it → traffic-driven recovery edge fires exactly once.
    health.recordUpstreamOutcome(P, A, { status: 429, resetHeaderSeconds: 5000 });
    health.recordUpstreamOutcome(P, A, { status: 200 });
    expect(seen).toEqual([A]);

    // A blocked account's (improbable) 2xx does NOT emit (it stays blocked).
    health.recordUpstreamOutcome(P, A, { status: 403, bodyText: 'this organization has been disabled' });
    health.recordUpstreamOutcome(P, A, { status: 200 });
    expect(seen).toEqual([A]); // unchanged
    expect(health.getStatus(P, A).state).toBe('blocked');
  });
});

describe('SubscriptionAccountHealth — recovery sweep + hook', () => {
  it('emits a recovery signal once a cooldown elapses (idle account)', () => {
    const { health, setNow } = makeTracker();
    const seen: Array<{ providerId: string; accountId: string }> = [];
    health.onRecovered((e) => seen.push({ providerId: e.providerId, accountId: e.accountId }));

    health.recordUpstreamOutcome(P, A, { status: 429, resetHeaderSeconds: 2000 });
    // Not yet elapsed → no recovery.
    expect(health.sweepRecoveries(1_500_000)).toEqual([]);
    expect(seen).toEqual([]);

    setNow(2_000_000);
    const recovered = health.sweepRecoveries(2_000_000);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ providerId: P, accountId: A, kind: 'rateLimitRecovery' });
    expect(seen).toEqual([{ providerId: P, accountId: A }]);
    // Idempotent: the recovered record is cleared, so a second sweep is a no-op.
    expect(health.sweepRecoveries(2_000_000)).toEqual([]);
  });

  it('a blocked account never recovers via the sweep', () => {
    const { health } = makeTracker();
    health.recordUpstreamOutcome(P, A, { status: 403, bodyText: 'oauth authentication is currently not allowed' });
    expect(health.sweepRecoveries(9_999_999)).toEqual([]);
    expect(health.isSchedulable(P, A)).toBe(false);
  });

  it('correctness does not depend on the tick — lazy read heals first', () => {
    const { health, setNow } = makeTracker();
    const listener = vi.fn();
    health.onRecovered(listener);
    health.recordUpstreamOutcome(P, A, { status: 429, resetHeaderSeconds: 2000 });
    setNow(2_000_000);
    // A read heals it BEFORE any sweep; the lazy path does not emit.
    expect(health.isSchedulable(P, A)).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    expect(health.sweepRecoveries(2_000_000)).toEqual([]);
  });
});

describe('resolveResetSeconds — per-provider (OQ2)', () => {
  it('claude is STRICT: only the unified reset header, ignores retry-after', () => {
    const headers = { 'anthropic-ratelimit-unified-reset': '7777', 'retry-after': '30' };
    expect(resolveResetSeconds('claude', headers)).toEqual({ resetHeaderSeconds: 7777, retryAfterSeconds: null });
  });

  it('non-claude accepts retry-after as a driver', () => {
    const headers = { 'retry-after': '45' };
    expect(resolveResetSeconds('codex', headers)).toEqual({ resetHeaderSeconds: null, retryAfterSeconds: 45 });
  });

  it('reads a Headers object too', () => {
    const headers = new Headers({ 'anthropic-ratelimit-unified-reset': '1234' });
    expect(resolveResetSeconds('claude', headers).resetHeaderSeconds).toBe(1234);
  });
});

describe('SubscriptionAccountHealth — configure()', () => {
  it('retunes the live overload behavior', () => {
    const { health } = makeTracker({ overloadEnabled: false });
    health.recordUpstreamOutcome(P, A, { status: 529 });
    expect(health.isSchedulable(P, A)).toBe(true); // disabled ⇒ not marked

    health.configure({ overloadEnabled: true, overloadTtlMs: 120_000 });
    health.recordUpstreamOutcome(P, A, { status: 529 });
    expect(health.isSchedulable(P, A)).toBe(false);
    expect(health.getStatus(P, A).cooldownUntil).toBe(1_000_000 + 120_000);
  });
});
