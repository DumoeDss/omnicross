/**
 * upstreamFetch tests (upstream-proxy) — the core egress seam.
 *
 * Covers the zero-regression fast path (no resolver / resolver-undefined ⇒ bare
 * fetch, no dispatcher), dispatcher attachment for http/https + socks5, the
 * per-proxy dispatcher cache, and the generation-bump invalidation (old
 * dispatcher disposed). Global `fetch` is stubbed so we assert on the `init` the
 * helper hands it WITHOUT any network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetUpstreamProxyForTests,
  bumpUpstreamProxyGeneration,
  fetchUpstream,
  resolveUpstreamDispatcher,
  setUpstreamProxyResolver,
} from '../upstreamFetch';

/** The `dispatcher` the helper attaches (undici-specific, absent from DOM lib). */
function dispatcherOf(init: RequestInit | undefined): unknown {
  return (init as { dispatcher?: unknown } | undefined)?.dispatcher;
}

describe('fetchUpstream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetUpstreamProxyForTests();
    fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    __resetUpstreamProxyForTests();
    vi.unstubAllGlobals();
  });

  it('is a BARE fetch when no resolver is registered (zero regression)', async () => {
    await fetchUpstream('https://api.example.com', { method: 'POST' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dispatcherOf(fetchMock.mock.calls[0]?.[1])).toBeUndefined();
  });

  it('is a BARE fetch when the resolver returns undefined', async () => {
    setUpstreamProxyResolver(() => undefined);
    await fetchUpstream('https://api.example.com', { method: 'POST' });
    expect(dispatcherOf(fetchMock.mock.calls[0]?.[1])).toBeUndefined();
  });

  it('attaches a dispatcher for an http proxy', async () => {
    setUpstreamProxyResolver(() => ({ type: 'http', host: '127.0.0.1', port: 8080 }));
    await fetchUpstream('https://api.example.com', { method: 'POST' });
    expect(dispatcherOf(fetchMock.mock.calls[0]?.[1])).toBeDefined();
  });

  it('attaches a dispatcher for a socks5 proxy', async () => {
    setUpstreamProxyResolver(() => ({ type: 'socks5', host: '127.0.0.1', port: 1080 }));
    const d = resolveUpstreamDispatcher({ providerId: 'claude' });
    expect(d).toBeDefined();
  });

  it('supports the { url } proxy shape', async () => {
    setUpstreamProxyResolver(() => ({ url: 'http://user:pass@127.0.0.1:3128' }));
    await fetchUpstream('https://api.example.com', {});
    expect(dispatcherOf(fetchMock.mock.calls[0]?.[1])).toBeDefined();
  });

  it('does not mutate the passed init on the bare path', async () => {
    const init: RequestInit = { method: 'POST', headers: { a: '1' } };
    await fetchUpstream('https://api.example.com', init);
    expect('dispatcher' in init).toBe(false);
  });
});

describe('resolveUpstreamDispatcher cache + generation', () => {
  beforeEach(() => __resetUpstreamProxyForTests());
  afterEach(() => __resetUpstreamProxyForTests());

  it('reuses one dispatcher for the same resolved proxy', () => {
    setUpstreamProxyResolver(() => ({ type: 'http', host: 'proxy.local', port: 8080 }));
    const a = resolveUpstreamDispatcher({ providerId: 'claude' });
    const b = resolveUpstreamDispatcher({ providerId: 'codex' });
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it('builds distinct dispatchers for distinct proxies', () => {
    setUpstreamProxyResolver((ctx) =>
      ctx.providerId === 'claude'
        ? { type: 'http', host: 'a.local', port: 8080 }
        : { type: 'http', host: 'b.local', port: 8080 },
    );
    const a = resolveUpstreamDispatcher({ providerId: 'claude' });
    const b = resolveUpstreamDispatcher({ providerId: 'codex' });
    expect(a).not.toBe(b);
  });

  it('rebuilds + disposes the old dispatcher after a generation bump', () => {
    setUpstreamProxyResolver(() => ({ type: 'http', host: 'proxy.local', port: 8080 }));
    const a = resolveUpstreamDispatcher({ providerId: 'claude' });
    expect(a).toBeDefined();
    const closeSpy = vi.spyOn(a as { close: () => Promise<void> }, 'close').mockResolvedValue(undefined);
    bumpUpstreamProxyGeneration();
    const b = resolveUpstreamDispatcher({ providerId: 'claude' });
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(b).not.toBe(a);
  });

  it('returns undefined when the resolver throws (never breaks egress)', () => {
    setUpstreamProxyResolver(() => {
      throw new Error('boom');
    });
    expect(resolveUpstreamDispatcher({ providerId: 'claude' })).toBeUndefined();
  });
});
