/**
 * The impit fetch primitive's pure surfaces: header ownership, proxy-URL
 * mapping, and the client cache's constructor options.
 *
 * No platform binary is needed — the constructor is injected, mirroring how
 * production falls back to undici when the dynamic import yields nothing.
 *
 * @module search/http/__tests__/impit.test
 */

import type { ProxyConfig } from '@omnicross/contracts/account-tokens-types';
import { describe, expect, it } from 'vitest';

import {
  IMPERSONATED_HEADERS,
  IMPIT_BROWSER,
  fetchKindOf,
  getImpitClient,
  impitProxyUrlFrom,
  proxyConfigToUrl,
  tagFetchKind,
  withImpersonatedHeaders,
  type ImpitConstructor,
} from '../impit';

describe('withImpersonatedHeaders', () => {
  it('deletes exactly the headers the impersonated fingerprint owns', () => {
    const init = withImpersonatedHeaders({
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152.0.7977.65',
        'sec-ch-ua': '"Chromium";v="152"',
        'Sec-CH-UA-Mobile': '?0',
        'SEC-CH-UA-PLATFORM': '"Windows"',
        Accept: 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const headers = new Headers(init.headers);
    for (const name of IMPERSONATED_HEADERS) {
      expect(headers.get(name)).toBeNull();
    }
    expect(headers.get('accept')).toBe('text/html');
    expect(headers.get('accept-language')).toBe('en-US,en;q=0.9');
  });
});

describe('proxyConfigToUrl', () => {
  it('passes http/https through and renders socks as socks5h (remote DNS)', () => {
    for (const url of ['http://127.0.0.1:7890', 'https://proxy.test:8443']) {
      expect(proxyConfigToUrl({ url })).toBe(url);
    }
    // impit's local-DNS socks5 hangs against real SOCKS servers; socks5h works.
    expect(proxyConfigToUrl({ url: 'socks5://127.0.0.1:7891' })).toBe('socks5h://127.0.0.1:7891');
    expect(proxyConfigToUrl({ url: 'socks5h://127.0.0.1:7891' })).toBe('socks5h://127.0.0.1:7891');
    expect(proxyConfigToUrl({ url: 'ftp://proxy.test' })).toBeUndefined();
    expect(proxyConfigToUrl({ url: 'not a url' })).toBeUndefined();
  });

  it('renders a typed config, embedding credentials', () => {
    const config: ProxyConfig = { type: 'socks5', host: '127.0.0.1', port: 7890 };
    expect(proxyConfigToUrl(config)).toBe('socks5h://127.0.0.1:7890');
    expect(proxyConfigToUrl({ ...config, username: 'u s', password: 'p/w' })).toBe(
      'socks5h://u%20s:p%2Fw@127.0.0.1:7890',
    );
    expect(proxyConfigToUrl({ type: 'http', host: '', port: 8080 })).toBeUndefined();
    expect(proxyConfigToUrl({ type: 'http', host: 'p.test', port: Number.NaN })).toBeUndefined();
  });
});

describe('impitProxyUrlFrom', () => {
  it('maps the layered resolver verdict, declining to undefined', () => {
    expect(
      impitProxyUrlFrom(() => ({ type: 'socks5', host: '127.0.0.1', port: 7890 }), 'https://x.test/'),
    ).toBe('socks5h://127.0.0.1:7890');
    expect(impitProxyUrlFrom(() => undefined, 'https://x.test/')).toBeUndefined();
    expect(impitProxyUrlFrom(undefined, 'https://x.test/')).toBeUndefined();
  });
});

describe('getImpitClient', () => {
  it('returns undefined when the binary is unavailable — the undici fallback', async () => {
    expect(await getImpitClient(undefined, async () => undefined)).toBeUndefined();
  });

  it('constructs with the verified options and caches per proxy URL', async () => {
    const constructed: Array<Record<string, unknown>> = [];
    let instanceCount = 0;
    const FakeImpit = class {
      constructor(options?: Record<string, unknown>) {
        instanceCount += 1;
        constructed.push(options ?? {});
      }

      fetch(): Promise<Response> {
        return Promise.reject(new Error('not used'));
      }
    } as unknown as ImpitConstructor;
    const load = async (): Promise<ImpitConstructor> => FakeImpit;

    await getImpitClient(undefined, load);
    await getImpitClient('socks5h://127.0.0.1:7890', load);
    await getImpitClient('socks5h://127.0.0.1:7890', load);

    expect(instanceCount).toBe(2);
    for (const options of constructed) {
      expect(options.browser).toBe(IMPIT_BROWSER);
      expect(options.followRedirects).toBe(false);
      expect(options.vanillaFallback).toBe(false);
    }
    expect(constructed[1].proxyUrl).toBe('socks5h://127.0.0.1:7890');
  });
});

describe('fetch kind tagging', () => {
  it('survives only on Error rejections and reads back the client that served', () => {
    const error = new Error('fetch failed');
    expect(fetchKindOf(error)).toBeUndefined();
    tagFetchKind(error, 'impit');
    expect(fetchKindOf(error)).toBe('impit');
    expect(fetchKindOf('not an error')).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('impit');
  });
});
