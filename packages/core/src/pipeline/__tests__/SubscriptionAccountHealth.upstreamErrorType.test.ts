/**
 * R11② pins (`claude-api-transform-fidelity`): the `upstreamErrorType` input
 * field is DIAGNOSTIC-ONLY — every decision branch of
 * `recordUpstreamOutcome` must produce the identical scheduling outcome with
 * and without it (table-driven), and the field must be surfaced in the log
 * line without ever influencing state.
 *
 * @module pipeline/__tests__/SubscriptionAccountHealth.upstreamErrorType.test
 */

import { describe, expect, it, vi } from 'vitest';

import { SubscriptionAccountHealth } from '../SubscriptionAccountHealth';

const P = 'claude';
const A = 'acct-A';

function fresh(): SubscriptionAccountHealth {
  return new SubscriptionAccountHealth({ now: () => 1_000_000 });
}

/** Serialize the scheduling-relevant state an outcome produced. */
function outcomeState(health: SubscriptionAccountHealth): unknown {
  return JSON.stringify({
    schedulable: health.isSchedulable(P, A),
    status: health.getStatus(P, A),
  });
}

describe('recordUpstreamOutcome upstreamErrorType (R11② diagnostic-only)', () => {
  it.each([
    ['a 529 with/without the type → identical overload cooldown', { status: 529 }],
    ['a 429 with a reset with/without the type → identical rate-limit', { status: 429, resetHeaderSeconds: 2000 }],
    ['a bare 429 with/without the type → both unmarked', { status: 429 }],
    ['a 500 with/without the type → identical transient cooldown', { status: 500 }],
    ['a 401 with/without the type → identical transient cooldown', { status: 401 }],
    ['a 400 with/without the type → both neutral', { status: 400 }],
    ['a 2xx with/without the type → both clear', { status: 200 }],
  ])('%s', (_name, input) => {
    const base = { ...input } as Record<string, unknown>;
    const withType = { ...input, upstreamErrorType: 'overloaded_error' } as Record<string, unknown>;
    const a = fresh();
    const b = fresh();
    a.recordUpstreamOutcome(P, A, base as never);
    b.recordUpstreamOutcome(P, A, withType as never);
    expect(outcomeState(b)).toEqual(outcomeState(a));
  });

  it('the field is surfaced in a structured log line and never mutates state', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const health = fresh();
      health.recordUpstreamOutcome(P, A, { status: 529, upstreamErrorType: 'overloaded_error' });
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('overloaded_error'),
      );
      expect(health.getStatus(P, A).state).toBe('overloaded');
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('absent field logs nothing', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      fresh().recordUpstreamOutcome(P, A, { status: 529 });
      expect(infoSpy).not.toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
    }
  });
});
