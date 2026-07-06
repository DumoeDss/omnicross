/**
 * OAuth-refresh proxy-ctx test (upstream-proxy M1).
 *
 * The credential store's refresh transport must thread the `{ providerId,
 * accountId }` ctx so a per-account (residential-IP) proxy is honored on REFRESH
 * exactly as on relay. Exercises the `buildRefreshFetch` seam: with an
 * account-scoped resolver, the refresh fetch for that account attaches the proxy
 * dispatcher, and a different account's refresh does NOT.
 */

import { Buffer } from 'node:buffer';

import {
  __resetUpstreamProxyForTests,
  setUpstreamProxyResolver,
} from '@omnicross/core/pipeline/upstreamFetch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonSubscriptionCredentialStore } from '../../ports/JsonSubscriptionCredentialStore';
import { SecretBox } from '../../secrets';
import { createUpstreamProxyResolver } from '../upstreamProxyResolver';

function dispatcherOf(init: RequestInit | undefined): unknown {
  return (init as { dispatcher?: unknown } | undefined)?.dispatcher;
}

describe('credential-store refresh honors the per-account proxy (M1)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const store = new JsonSubscriptionCredentialStore('/no/such/tokens.json', new SecretBox(Buffer.alloc(32, 3)));

  beforeEach(() => {
    __resetUpstreamProxyForTests();
    fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    // Per-account proxy only for provider=claude, account=acc1.
    setUpstreamProxyResolver(
      createUpstreamProxyResolver({
        getServerProxy: () => undefined,
        env: {},
        getAccountProxy: (providerId, accountId) =>
          providerId === 'claude' && accountId === 'acc1'
            ? { type: 'http', host: 'residential.proxy', port: 8080 }
            : undefined,
      }),
    );
  });

  afterEach(() => {
    __resetUpstreamProxyForTests();
    vi.unstubAllGlobals();
  });

  it("the account's refresh fetch routes through that account's proxy", async () => {
    await store.buildRefreshFetch('claude', 'acc1')('https://api.anthropic.com/refresh', {});
    expect(dispatcherOf(fetchMock.mock.calls[0]?.[1])).toBeDefined();
  });

  it('a different account refreshes direct (no per-account proxy)', async () => {
    await store.buildRefreshFetch('claude', 'acc2')('https://api.anthropic.com/refresh', {});
    expect(dispatcherOf(fetchMock.mock.calls[0]?.[1])).toBeUndefined();
  });

  it('a test-injected transport is used verbatim (no proxy threading)', async () => {
    const injected = vi.fn(async () => new Response('{}'));
    const custom = new JsonSubscriptionCredentialStore(
      '/no/such/tokens.json',
      new SecretBox(Buffer.alloc(32, 3)),
      injected,
    );
    const fl = custom.buildRefreshFetch('claude', 'acc1');
    await fl('https://api.anthropic.com/refresh', {});
    expect(injected).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
