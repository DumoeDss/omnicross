/**
 * upstreamProxyResolver tests (upstream-proxy) — the daemon's layered lookup.
 *
 * Asserts the full precedence chain (account > provider > global > env), the
 * `NO_PROXY` bypass at the env layer, and the zero-config direct-fetch case
 * (every layer empty ⇒ undefined). The core dispatcher seam is exercised
 * separately (upstreamFetch.test.ts) — here we test the resolver's DECISION.
 */

import type { OutboundProxyConfig } from '@omnicross/core';
import type { ProxyConfig } from '@omnicross/contracts/account-tokens-types';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createUpstreamProxyResolver,
  getServerProxyConfig,
  resolveEnvProxy,
  setServerProxyConfig,
} from '../upstreamProxyResolver';

const GLOBAL: ProxyConfig = { type: 'http', host: 'global.local', port: 8080 };
const PROVIDER: ProxyConfig = { type: 'http', host: 'provider.local', port: 8080 };
const ACCOUNT: ProxyConfig = { type: 'http', host: 'account.local', port: 8080 };

function serverProxy(over: Partial<OutboundProxyConfig> = {}): OutboundProxyConfig {
  return { global: GLOBAL, byProvider: { claude: PROVIDER }, ...over };
}

describe('createUpstreamProxyResolver — precedence', () => {
  afterEach(() => setServerProxyConfig(undefined));

  it('account override wins over provider/global/env', () => {
    const resolve = createUpstreamProxyResolver({
      getServerProxy: () => serverProxy(),
      getAccountProxy: () => ACCOUNT,
      env: { HTTPS_PROXY: 'http://env.local:8080' },
    });
    expect(resolve({ providerId: 'claude', accountId: 'a1' })).toEqual(ACCOUNT);
  });

  it('provider wins over global/env when no account proxy', () => {
    const resolve = createUpstreamProxyResolver({
      getServerProxy: () => serverProxy(),
      getAccountProxy: () => undefined,
      env: { HTTPS_PROXY: 'http://env.local:8080' },
    });
    expect(resolve({ providerId: 'claude', accountId: 'a1' })).toEqual(PROVIDER);
  });

  it('global wins over env when no account/provider proxy', () => {
    const resolve = createUpstreamProxyResolver({
      getServerProxy: () => ({ global: GLOBAL }),
      env: { HTTPS_PROXY: 'http://env.local:8080' },
    });
    expect(resolve({ providerId: 'codex' })).toEqual(GLOBAL);
  });

  it('env is the lowest layer (used when config is empty)', () => {
    const resolve = createUpstreamProxyResolver({
      getServerProxy: () => undefined,
      env: { HTTPS_PROXY: 'http://env.local:8080' },
    });
    expect(resolve({ providerId: 'codex' })).toEqual({ url: 'http://env.local:8080' });
  });

  it('zero-config ⇒ undefined (direct fetch)', () => {
    const resolve = createUpstreamProxyResolver({ getServerProxy: () => undefined, env: {} });
    expect(resolve({ providerId: 'claude', accountId: 'a1' })).toBeUndefined();
    expect(resolve({})).toBeUndefined();
  });

  it('a BYO provider gets no per-provider match but still falls to global', () => {
    const resolve = createUpstreamProxyResolver({
      getServerProxy: () => serverProxy(),
      env: {},
    });
    expect(resolve({ providerId: 'byo' })).toEqual(GLOBAL);
  });
});

describe('resolveEnvProxy — host-based bypass', () => {
  const REMOTE = { url: 'https://api.anthropic.com/v1/messages' };

  it('honors HTTPS_PROXY / http_proxy / ALL_PROXY', () => {
    expect(resolveEnvProxy(REMOTE, { HTTPS_PROXY: 'http://p:8080' })).toEqual({ url: 'http://p:8080' });
    expect(resolveEnvProxy(REMOTE, { http_proxy: 'http://p:8080' })).toEqual({ url: 'http://p:8080' });
    expect(resolveEnvProxy(REMOTE, { ALL_PROXY: 'socks5://p:1080' })).toEqual({ url: 'socks5://p:1080' });
  });

  it('bypasses when NO_PROXY covers the target host', () => {
    expect(
      resolveEnvProxy(REMOTE, { HTTPS_PROXY: 'http://p:8080', NO_PROXY: 'anthropic.com' }),
    ).toBeUndefined();
    expect(
      resolveEnvProxy(REMOTE, { HTTPS_PROXY: 'http://p:8080', NO_PROXY: '*' }),
    ).toBeUndefined();
  });

  it('bypasses a loopback target even with an env proxy set', () => {
    expect(
      resolveEnvProxy({ url: 'http://127.0.0.1:9931/v1/messages' }, { HTTPS_PROXY: 'http://p:8080' }),
    ).toBeUndefined();
    expect(
      resolveEnvProxy({ url: 'http://localhost:9931/v1/messages' }, { HTTPS_PROXY: 'http://p:8080' }),
    ).toBeUndefined();
  });

  it('still proxies a host NOT covered by NO_PROXY', () => {
    expect(
      resolveEnvProxy(
        { url: 'https://chatgpt.com/backend-api/codex/responses' },
        { HTTPS_PROXY: 'http://p:8080', NO_PROXY: 'anthropic.com' },
      ),
    ).toEqual({ url: 'http://p:8080' });
  });

  it('returns undefined when no env proxy is set', () => {
    expect(resolveEnvProxy(REMOTE, {})).toBeUndefined();
  });
});

describe('createUpstreamProxyResolver — universal bypass (loopback + NO_PROXY)', () => {
  it('never proxies a loopback target, even with an explicit global proxy', () => {
    const resolve = createUpstreamProxyResolver({
      getServerProxy: () => ({ global: GLOBAL }),
      env: { HTTPS_PROXY: 'http://env.local:8080' },
    });
    expect(resolve({ providerId: 'claude', url: 'http://127.0.0.1:8899/v1/messages' })).toBeUndefined();
  });

  it('NO_PROXY bypasses ALL layers — even an explicit account/provider/global proxy', () => {
    const resolve = createUpstreamProxyResolver({
      getServerProxy: () => serverProxy(),
      getAccountProxy: () => ACCOUNT,
      env: { NO_PROXY: 'anthropic.com' },
    });
    // Account proxy would normally win, but the host is in NO_PROXY → direct.
    expect(
      resolve({ providerId: 'claude', accountId: 'a1', url: 'https://api.anthropic.com/v1/messages' }),
    ).toBeUndefined();
    // A host NOT in NO_PROXY still resolves the account proxy.
    expect(
      resolve({ providerId: 'claude', accountId: 'a1', url: 'https://chatgpt.com/x' }),
    ).toEqual(ACCOUNT);
  });
});

describe('setServerProxyConfig holder', () => {
  afterEach(() => setServerProxyConfig(undefined));

  it('swaps the live segment the default resolver reads', () => {
    setServerProxyConfig({ global: GLOBAL });
    expect(getServerProxyConfig()).toEqual({ global: GLOBAL });
    const resolve = createUpstreamProxyResolver({ env: {} });
    expect(resolve({ providerId: 'codex' })).toEqual(GLOBAL);
    setServerProxyConfig(undefined);
    expect(resolve({ providerId: 'codex' })).toBeUndefined();
  });
});
