import { describe, expect, it } from 'vitest';

import {
  type AccountAnomalyEvent,
  SubscriptionAccountHealth,
} from '../SubscriptionAccountHealth';

/** A tracker with a fixed clock + an anomaly capture buffer. */
function makeTracker(now = 1_000_000) {
  const events: AccountAnomalyEvent[] = [];
  const health = new SubscriptionAccountHealth({ now: () => now });
  health.onAnomaly((e) => events.push(e));
  return { health, events };
}

describe('SubscriptionAccountHealth — onAnomaly (webhook-notifications D3)', () => {
  it('fires blocked on a 403-ban edge', () => {
    const { health, events } = makeTracker();
    health.recordUpstreamOutcome('claude', 'a1', {
      status: 403,
      bodyText: 'This organization has been disabled.',
    });
    expect(events).toEqual([{ providerId: 'claude', accountId: 'a1', at: 1_000_000, state: 'blocked' }]);
  });

  it('fires unauthorized on a 401 edge', () => {
    const { health, events } = makeTracker();
    health.recordUpstreamOutcome('codex', 'a2', { status: 401 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ providerId: 'codex', accountId: 'a2', state: 'unauthorized' });
  });

  it('fires rate_limited on a 429-with-reset edge', () => {
    const { health, events } = makeTracker();
    health.recordUpstreamOutcome('claude', 'a3', { status: 429, resetHeaderSeconds: 2_000 });
    expect(events[0]).toMatchObject({ state: 'rate_limited' });
  });

  it('fires overloaded on a 529 edge', () => {
    const { health, events } = makeTracker();
    health.recordUpstreamOutcome('claude', 'a4', { status: 529 });
    expect(events[0]).toMatchObject({ state: 'overloaded' });
  });

  it('does NOT fire for a bare 429 (unmarked → no state)', () => {
    const { health, events } = makeTracker();
    health.recordUpstreamOutcome('claude', 'a5', { status: 429 });
    expect(events).toHaveLength(0);
  });

  it('does NOT fire for a 5xx transient (server error, not an account state)', () => {
    const { health, events } = makeTracker();
    health.recordUpstreamOutcome('claude', 'a6', { status: 503 });
    expect(events).toHaveLength(0);
  });

  it('is edge-triggered — an already-unhealthy account escalating does not re-fire', () => {
    const { health, events } = makeTracker();
    // First edge: healthy → rate_limited.
    health.recordUpstreamOutcome('claude', 'a7', { status: 429, resetHeaderSeconds: 2_000 });
    // Escalate the SAME (still-unhealthy) account to blocked → NOT a healthy→unhealthy edge.
    health.recordUpstreamOutcome('claude', 'a7', {
      status: 403,
      bodyText: 'OAuth authentication is currently not allowed',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ state: 'rate_limited' });
  });

  it('re-fires after a recovery (a new healthy→unhealthy edge)', () => {
    const { health, events } = makeTracker();
    health.recordUpstreamOutcome('claude', 'a8', { status: 401 });
    // Recover with a 2xx, then fail again → a fresh edge.
    health.recordUpstreamOutcome('claude', 'a8', { status: 200 });
    health.recordUpstreamOutcome('claude', 'a8', { status: 401 });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.state === 'unauthorized')).toBe(true);
  });

  it('does not disrupt marking when a listener throws', () => {
    const health = new SubscriptionAccountHealth({ now: () => 1 });
    health.onAnomaly(() => {
      throw new Error('bad consumer');
    });
    expect(() => health.recordUpstreamOutcome('claude', 'a9', { status: 401 })).not.toThrow();
    // The account is still marked unhealthy despite the throwing listener.
    expect(health.isSchedulable('claude', 'a9', 1)).toBe(false);
  });

  it('existing recovery behavior is UNCHANGED (no anomaly on a 2xx)', () => {
    const { health, events } = makeTracker();
    let recovered = 0;
    health.onRecovered(() => recovered++);
    health.recordUpstreamOutcome('claude', 'a10', { status: 429, resetHeaderSeconds: 2_000 });
    health.recordUpstreamOutcome('claude', 'a10', { status: 200 });
    expect(recovered).toBe(1);
    // Only the initial rate-limit edge produced an anomaly; the 2xx produced none.
    expect(events).toHaveLength(1);
  });
});
