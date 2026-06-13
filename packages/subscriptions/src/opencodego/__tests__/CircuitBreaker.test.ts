/**
 * CircuitBreaker state-machine tests — every transition ported from
 * `_others/oc-go-cc/internal/router/fallback.go`, exercised with an INJECTED
 * mutable clock so the 30s open window is crossed deterministically (no real
 * timers / no waits — design D5).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { CircuitBreaker, CircuitBreakerRegistry } from '../CircuitBreaker';

/** A controllable clock: `clock.t` is the current ms; advance by mutating it. */
function makeClock(): { t: number; now: () => number } {
  const clock = { t: 0, now: () => clock.t };
  return clock;
}

describe('CircuitBreaker (state machine)', () => {
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    clock = makeClock();
  });

  it('opens after exactly 3 consecutive failures', () => {
    const cb = new CircuitBreaker({ now: clock.now });
    expect(cb.getState()).toBe('closed');
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    cb.recordFailure(); // 3rd consecutive → open
    expect(cb.getState()).toBe('open');
    // Open rejects further requests within the 30s window.
    expect(cb.allowRequest()).toBe(false);
  });

  it('a closed success resets the consecutive failure count', () => {
    const cb = new CircuitBreaker({ now: clock.now });
    cb.recordFailure();
    cb.recordFailure(); // 2 consecutive
    cb.recordSuccess(); // resets the streak
    expect(cb.getState()).toBe('closed');
    // A single later failure must NOT open it (count was reset).
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    // It takes a fresh run of 3 consecutive to open.
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });

  it('open transitions to half-open after the 30s window and admits the call', () => {
    const cb = new CircuitBreaker({ now: clock.now });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure(); // open at t=0
    expect(cb.getState()).toBe('open');

    // Still within the window → rejected, still open.
    clock.t = 30_000; // exactly 30s — NOT strictly greater than openMs
    expect(cb.allowRequest()).toBe(false);
    expect(cb.getState()).toBe('open');

    // Just past 30s → flips to half-open and admits.
    clock.t = 30_001;
    expect(cb.allowRequest()).toBe(true);
    expect(cb.getState()).toBe('half-open');
  });

  it('half-open admits at most 3 test calls', () => {
    const cb = new CircuitBreaker({ now: clock.now });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    clock.t = 31_000;
    // 1st admission flips open → half-open.
    expect(cb.allowRequest()).toBe(true); // call 1
    expect(cb.getState()).toBe('half-open');
    expect(cb.allowRequest()).toBe(true); // call 2
    expect(cb.allowRequest()).toBe(true); // call 3
    // 4th is rejected (cap reached, no outcome recorded yet).
    expect(cb.allowRequest()).toBe(false);
    expect(cb.getState()).toBe('half-open');
  });

  it('half-open closes after 3 successes and resets counters', () => {
    const cb = new CircuitBreaker({ now: clock.now });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    clock.t = 31_000;
    cb.allowRequest(); // enter half-open
    cb.recordSuccess();
    expect(cb.getState()).toBe('half-open');
    cb.recordSuccess();
    expect(cb.getState()).toBe('half-open');
    cb.recordSuccess(); // 3rd success → closed
    expect(cb.getState()).toBe('closed');

    // Counters reset: it again takes 3 consecutive failures to re-open.
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });

  it('half-open re-opens immediately on a single failure', () => {
    const cb = new CircuitBreaker({ now: clock.now });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    clock.t = 31_000;
    cb.allowRequest(); // enter half-open
    cb.recordSuccess(); // 1 success, not yet closed
    expect(cb.getState()).toBe('half-open');
    cb.recordFailure(); // one probe failure → back to open
    expect(cb.getState()).toBe('open');
    // The re-open re-stamped lastFailureTime, so the window restarts.
    expect(cb.allowRequest()).toBe(false);
    clock.t = 31_000 + 30_001;
    expect(cb.allowRequest()).toBe(true);
    expect(cb.getState()).toBe('half-open');
  });

  it('defaults to Date.now when no clock is injected (production path)', () => {
    const cb = new CircuitBreaker();
    // Without crossing a real 30s window, an opened circuit stays open.
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    expect(cb.allowRequest()).toBe(false);
  });

  it('honors custom threshold / openMs / halfOpenMaxCalls', () => {
    const cb = new CircuitBreaker({ threshold: 2, openMs: 1_000, halfOpenMaxCalls: 1, now: clock.now });
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    cb.recordFailure(); // threshold=2 → open
    expect(cb.getState()).toBe('open');
    clock.t = 1_001; // > openMs
    expect(cb.allowRequest()).toBe(true); // half-open, admits 1
    expect(cb.allowRequest()).toBe(false); // cap=1 reached
    cb.recordSuccess(); // 1 success closes (halfOpenMaxCalls=1)
    expect(cb.getState()).toBe('closed');
  });
});

describe('CircuitBreakerRegistry (per-model lazy map)', () => {
  it('isolates breaker state per model id', () => {
    const clock = makeClock();
    const reg = new CircuitBreakerRegistry({ now: clock.now });
    // Open model-a, leave model-b closed.
    reg.recordFailure('model-a');
    reg.recordFailure('model-a');
    reg.recordFailure('model-a');
    expect(reg.allowRequest('model-a')).toBe(false);
    expect(reg.allowRequest('model-b')).toBe(true);
    // model-b is unaffected by model-a's failures.
    reg.recordFailure('model-b');
    expect(reg.allowRequest('model-b')).toBe(true);
  });

  it('lazily creates a fresh closed breaker on first sight of a model', () => {
    const reg = new CircuitBreakerRegistry();
    // Never recorded → admitted (closed).
    expect(reg.allowRequest('brand-new-model')).toBe(true);
  });

  it('threads the shared clock to every child breaker', () => {
    const clock = makeClock();
    const reg = new CircuitBreakerRegistry({ now: clock.now });
    reg.recordFailure('m');
    reg.recordFailure('m');
    reg.recordFailure('m');
    expect(reg.allowRequest('m')).toBe(false);
    clock.t = 30_001;
    // The shared clock advanced → the child breaker flips to half-open.
    expect(reg.allowRequest('m')).toBe(true);
  });
});
