/**
 * Proxy config normalization tests (upstream-proxy) — the `server.proxy` segment.
 * Asserts malformed entries drop, valid entries survive, and a missing segment
 * stays ABSENT (zero-config = direct fetch; no synthesized default).
 */

import { describe, expect, it } from 'vitest';

import {
  mergeServerConfig,
  normalizeProxyConfig,
  normalizeProxySegment,
  normalizeServerConfig,
} from '../apiServerConfig';

describe('normalizeProxyConfig', () => {
  it('accepts the { url } form', () => {
    expect(normalizeProxyConfig({ url: '  socks5://h:1080  ' })).toEqual({ url: 'socks5://h:1080' });
  });

  it('accepts a valid structured proxy + keeps username/password', () => {
    expect(
      normalizeProxyConfig({ type: 'http', host: 'h', port: 8080, username: 'u', password: 'p' }),
    ).toEqual({ type: 'http', host: 'h', port: 8080, username: 'u', password: 'p' });
  });

  it('drops an invalid type / missing host / out-of-range port', () => {
    expect(normalizeProxyConfig({ type: 'ftp', host: 'h', port: 8080 })).toBeUndefined();
    expect(normalizeProxyConfig({ type: 'http', host: '', port: 8080 })).toBeUndefined();
    expect(normalizeProxyConfig({ type: 'http', host: 'h', port: 0 })).toBeUndefined();
    expect(normalizeProxyConfig(null)).toBeUndefined();
  });
});

describe('normalizeProxySegment', () => {
  it('keeps only valid global + byProvider entries', () => {
    expect(
      normalizeProxySegment({
        global: { type: 'http', host: 'g', port: 8080 },
        byProvider: {
          claude: { url: 'http://c:8080' },
          bad: { type: 'nope', host: 'x', port: 1 },
        },
      }),
    ).toEqual({
      global: { type: 'http', host: 'g', port: 8080 },
      byProvider: { claude: { url: 'http://c:8080' } },
    });
  });

  it('returns undefined when nothing valid remains', () => {
    expect(normalizeProxySegment({ byProvider: { x: { type: 'bad', host: '', port: 0 } } })).toBeUndefined();
    expect(normalizeProxySegment(undefined)).toBeUndefined();
  });
});

describe('server config threading', () => {
  it('a config with no proxy stays absent (zero-config)', () => {
    const config = normalizeServerConfig({ enabled: false });
    expect(config.proxy).toBeUndefined();
  });

  it('normalizeServerConfig carries a valid proxy segment', () => {
    const config = normalizeServerConfig({ proxy: { global: { url: 'http://g:8080' } } });
    expect(config.proxy).toEqual({ global: { url: 'http://g:8080' } });
  });

  it('mergeServerConfig replaces the proxy segment when the patch carries one', () => {
    const current = normalizeServerConfig({ proxy: { global: { url: 'http://old:8080' } } });
    const merged = mergeServerConfig(current, { proxy: { global: { url: 'http://new:8080' } } });
    expect(merged.proxy).toEqual({ global: { url: 'http://new:8080' } });
  });

  it('mergeServerConfig keeps the current proxy when the patch omits it', () => {
    const current = normalizeServerConfig({ proxy: { global: { url: 'http://keep:8080' } } });
    const merged = mergeServerConfig(current, { enabled: true });
    expect(merged.proxy).toEqual({ global: { url: 'http://keep:8080' } });
  });
});
