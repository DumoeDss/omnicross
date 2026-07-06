import { describe, expect, it } from 'vitest';

import { defaultServerConfig, mergeServerConfig, normalizeBilling, normalizeServerConfig } from '../apiServerConfig';

describe('normalizeBilling', () => {
  it('defaults to disabled with the frozen defaults (zero regression)', () => {
    expect(normalizeBilling(undefined)).toEqual({ enabled: false, maxRetryAgeMs: 24 * 60 * 60_000 });
  });

  it('carries endpoint + secret + clamps maxRetryAgeMs when enabled', () => {
    const b = normalizeBilling({
      billing: { enabled: true, endpoint: '  https://sink.example/billing  ', secret: 'hmac', maxRetryAgeMs: 3_600_000 },
    });
    expect(b.enabled).toBe(true);
    expect(b.endpoint).toBe('https://sink.example/billing'); // trimmed
    expect(b.secret).toBe('hmac');
    expect(b.maxRetryAgeMs).toBe(3_600_000);
  });

  it('drops a blank endpoint (ledger-only mode)', () => {
    const b = normalizeBilling({ billing: { enabled: true, endpoint: '   ', maxRetryAgeMs: 1000 } });
    expect(b.endpoint).toBeUndefined();
    expect(b.enabled).toBe(true);
  });

  it('clamps maxRetryAgeMs to its valid range', () => {
    expect(normalizeBilling({ billing: { enabled: true, maxRetryAgeMs: 1 } }).maxRetryAgeMs).toBe(60_000);
    expect(normalizeBilling({ billing: { enabled: true, maxRetryAgeMs: 9_999_999_999 } }).maxRetryAgeMs).toBe(
      2_592_000_000,
    );
  });
});

describe('normalizeServerConfig — billing segment', () => {
  it('always fills the billing segment (default disabled)', () => {
    expect(defaultServerConfig().billing).toEqual(normalizeBilling(undefined));
    expect(normalizeServerConfig(null).billing?.enabled).toBe(false);
  });

  it('carries an enabled billing segment through', () => {
    const cfg = normalizeServerConfig({
      billing: { enabled: true, endpoint: 'https://sink', secret: 's', maxRetryAgeMs: 7_200_000 },
    });
    expect(cfg.billing).toEqual({ enabled: true, endpoint: 'https://sink', secret: 's', maxRetryAgeMs: 7_200_000 });
  });
});

describe('mergeServerConfig — billing segment', () => {
  it('replaces the billing segment from a patch, keeping current when omitted', () => {
    const current = normalizeServerConfig({ billing: { enabled: true, endpoint: 'https://x', maxRetryAgeMs: 1000 } });
    expect(mergeServerConfig(current, { enabled: true }).billing?.endpoint).toBe('https://x');
    expect(mergeServerConfig(current, { billing: { enabled: false, maxRetryAgeMs: 1000 } }).billing?.enabled).toBe(
      false,
    );
  });
});
