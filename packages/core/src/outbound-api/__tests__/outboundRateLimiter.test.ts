/**
 * Unit tests for the per-key rate limiter (`outbound-api-server` task 8.6).
 */
import { describe, expect, it } from 'vitest';

import { OutboundRateLimiter } from '../outboundRateLimiter';

describe('OutboundRateLimiter', () => {
  it('allows up to the limit then returns 429 + Retry-After', () => {
    const limiter = new OutboundRateLimiter({ windowMs: 1000, maxRequests: 3 });
    const now = 10_000;
    expect(limiter.check('k', now).allowed).toBe(true);
    expect(limiter.check('k', now).allowed).toBe(true);
    expect(limiter.check('k', now).allowed).toBe(true);
    const denied = limiter.check('k', now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('frees up after the window slides past', () => {
    const limiter = new OutboundRateLimiter({ windowMs: 1000, maxRequests: 1 });
    expect(limiter.check('k', 0).allowed).toBe(true);
    expect(limiter.check('k', 500).allowed).toBe(false);
    // After the window, the first hit aged out.
    expect(limiter.check('k', 1500).allowed).toBe(true);
  });

  it('isolates keys', () => {
    const limiter = new OutboundRateLimiter({ windowMs: 1000, maxRequests: 1 });
    expect(limiter.check('a', 0).allowed).toBe(true);
    expect(limiter.check('a', 0).allowed).toBe(false);
    // A different key has its own window.
    expect(limiter.check('b', 0).allowed).toBe(true);
  });
});
