/**
 * Cross-run isolation + idle-reaper tests for `ProviderProxyRouteMap`
 * (OpenSpec `engine-provider-decouple` tasks 3.1 + 3.3).
 *
 * @module provider-proxy/__tests__/providerProxyRouteMap.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isLoopbackAddress } from '../ProviderProxy';
import { ProviderProxyRouteMap } from '../providerProxyRouteMap';
import type { RouteContext } from '../types';

function makeCtx(sessionId: string): RouteContext {
  return {
    sessionId,
    targetProviderFormat: 'anthropic',
    model: 'claude-x',
    ingressFormat: 'anthropic-messages',
    authMode: 'byo',
    providerId: 'prov-1',
  };
}

describe('ProviderProxyRouteMap — cross-run isolation (task 3.1)', () => {
  it('mints distinct unguessable tokens per route', () => {
    const map = new ProviderProxyRouteMap();
    const a = map.addRoute(makeCtx('sess-A'));
    const b = map.addRoute(makeCtx('sess-B'));
    expect(a).not.toBe(b);
    // 32 bytes hex = 64 chars of [0-9a-f].
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    map.clear();
  });

  it("run A's token resolves ONLY run A's context, never run B's", () => {
    const map = new ProviderProxyRouteMap();
    const tokenA = map.addRoute(makeCtx('sess-A'));
    const tokenB = map.addRoute(makeCtx('sess-B'));

    expect(map.lookup(tokenA)?.sessionId).toBe('sess-A');
    expect(map.lookup(tokenB)?.sessionId).toBe('sess-B');
    // No token resolves the other run's context.
    expect(map.lookup(tokenA)?.sessionId).not.toBe('sess-B');
    map.clear();
  });

  it('rejects a fabricated token (lookup miss → undefined, no fallback)', () => {
    const map = new ProviderProxyRouteMap();
    map.addRoute(makeCtx('sess-A'));
    expect(map.lookup('deadbeef'.repeat(8))).toBeUndefined();
    expect(map.lookup(undefined)).toBeUndefined();
    expect(map.lookup(null)).toBeUndefined();
    expect(map.lookup('')).toBeUndefined();
    map.clear();
  });

  it('a removed token can never resolve again (run-end removal)', () => {
    const map = new ProviderProxyRouteMap();
    const token = map.addRoute(makeCtx('sess-A'));
    expect(map.lookup(token)).toBeDefined();
    expect(map.removeRoute(token)).toBe(true);
    expect(map.lookup(token)).toBeUndefined();
    expect(map.removeRoute(token)).toBe(false);
  });

  it('the listener refuses non-loopback origins (isLoopbackAddress gate)', () => {
    // Loopback peers are accepted.
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.0.0.5')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    // Non-loopback peers are refused.
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
    expect(isLoopbackAddress('10.0.0.2')).toBe(false);
    expect(isLoopbackAddress('::ffff:192.168.1.10')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('ProviderProxyRouteMap — idle reaper (task 3.3)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reaps an idle entry after the TTL', () => {
    const map = new ProviderProxyRouteMap();
    const token = map.addRoute(makeCtx('sess-idle'), 1000);
    expect(map.lookup(token)).toBeDefined();

    vi.advanceTimersByTime(1001);
    // After the TTL with no touch, the entry is reaped → lookup miss.
    expect(map.has(token)).toBe(false);
    expect(map.lookup(token)).toBeUndefined();
  });

  it('an active entry (touched on lookup) survives past the TTL', () => {
    const map = new ProviderProxyRouteMap();
    const token = map.addRoute(makeCtx('sess-active'), 1000);

    // Touch every 600ms (< TTL) → the entry is re-armed and never reaped.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(600);
      expect(map.lookup(token)).toBeDefined();
    }
    // Total elapsed 3000ms ≫ 1000ms TTL, but each touch re-armed the timer.
    expect(map.has(token)).toBe(true);
    map.clear();
  });

  it("unref's the idle timer so it never holds the process open", () => {
    const unref = vi.fn();
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: (...a: unknown[]) => void,
      ms?: number,
    ) => {
      const handle = realSetTimeout(fn, ms);
      // Attach a spy unref so we can assert it was called.
      (handle as unknown as { unref: () => void }).unref = unref;
      return handle;
    }) as unknown as typeof setTimeout);

    const map = new ProviderProxyRouteMap();
    map.addRoute(makeCtx('sess-unref'), 5000);
    expect(unref).toHaveBeenCalled();

    spy.mockRestore();
    map.clear();
  });
});
