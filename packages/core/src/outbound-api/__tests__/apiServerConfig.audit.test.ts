import { describe, expect, it } from 'vitest';

import { defaultServerConfig, mergeServerConfig, normalizeAudit, normalizeServerConfig } from '../apiServerConfig';

describe('normalizeAudit', () => {
  it('defaults to disabled with the frozen defaults (zero regression)', () => {
    expect(normalizeAudit(undefined)).toEqual({
      enabled: false,
      captureBodies: false,
      maxBodyBytes: 8192,
      retentionDays: 7,
      trustForwardedFor: false,
    });
  });

  it('coerces the three flags to booleans', () => {
    const a = normalizeAudit({
      audit: {
        enabled: true,
        captureBodies: true,
        trustForwardedFor: true,
        maxBodyBytes: 4096,
        retentionDays: 30,
      },
    });
    expect(a.enabled).toBe(true);
    expect(a.captureBodies).toBe(true);
    expect(a.trustForwardedFor).toBe(true);
    expect(a.maxBodyBytes).toBe(4096);
    expect(a.retentionDays).toBe(30);
  });

  it('clamps maxBodyBytes and retentionDays to their valid ranges', () => {
    const low = normalizeAudit({ audit: { enabled: true, captureBodies: false, maxBodyBytes: 1, retentionDays: 0, trustForwardedFor: false } });
    expect(low.maxBodyBytes).toBe(256);
    expect(low.retentionDays).toBe(1);
    const high = normalizeAudit({ audit: { enabled: true, captureBodies: false, maxBodyBytes: 99_999_999, retentionDays: 9999, trustForwardedFor: false } });
    expect(high.maxBodyBytes).toBe(1_048_576);
    expect(high.retentionDays).toBe(365);
  });
});

describe('normalizeServerConfig — audit segment', () => {
  it('always fills the audit segment (default disabled)', () => {
    expect(defaultServerConfig().audit).toEqual(normalizeAudit(undefined));
    expect(normalizeServerConfig(null).audit?.enabled).toBe(false);
  });

  it('carries an enabled audit segment through', () => {
    const cfg = normalizeServerConfig({
      audit: { enabled: true, captureBodies: true, maxBodyBytes: 2048, retentionDays: 14, trustForwardedFor: false },
    });
    expect(cfg.audit).toEqual({
      enabled: true,
      captureBodies: true,
      maxBodyBytes: 2048,
      retentionDays: 14,
      trustForwardedFor: false,
    });
  });
});

describe('mergeServerConfig — audit segment', () => {
  it('replaces the audit segment from a patch, keeping current when omitted', () => {
    const current = normalizeServerConfig({ audit: { enabled: true, captureBodies: false, maxBodyBytes: 8192, retentionDays: 7, trustForwardedFor: false } });
    const kept = mergeServerConfig(current, { enabled: true });
    expect(kept.audit?.enabled).toBe(true);
    const swapped = mergeServerConfig(current, {
      audit: { enabled: false, captureBodies: false, maxBodyBytes: 8192, retentionDays: 7, trustForwardedFor: false },
    });
    expect(swapped.audit?.enabled).toBe(false);
  });
});
