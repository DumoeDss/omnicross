import { describe, expect, it } from 'vitest';

import {
  defaultServerConfig,
  mergeServerConfig,
  normalizeFingerprint,
  normalizeServerConfig,
} from '../apiServerConfig';

describe('normalizeFingerprint', () => {
  it('defaults to disabled with no UA baseline (zero regression)', () => {
    expect(normalizeFingerprint(undefined)).toEqual({ enabled: false });
  });

  it('carries enabled + a trimmed UA baseline', () => {
    const f = normalizeFingerprint({ fingerprint: { enabled: true, ua: '  claude-cli/1.0  ' } });
    expect(f.enabled).toBe(true);
    expect(f.ua).toBe('claude-cli/1.0');
  });

  it('drops a blank UA baseline', () => {
    const f = normalizeFingerprint({ fingerprint: { enabled: true, ua: '   ' } });
    expect(f.enabled).toBe(true);
    expect(f.ua).toBeUndefined();
  });

  it('coerces a non-true enabled to false', () => {
    expect(normalizeFingerprint({ fingerprint: { enabled: 'yes' as never } }).enabled).toBe(false);
  });
});

describe('normalizeServerConfig — fingerprint segment', () => {
  it('always fills the fingerprint segment (default disabled)', () => {
    expect(defaultServerConfig().fingerprint).toEqual({ enabled: false });
    expect(normalizeServerConfig(null).fingerprint?.enabled).toBe(false);
  });

  it('carries an enabled fingerprint segment through', () => {
    const cfg = normalizeServerConfig({ fingerprint: { enabled: true, ua: 'ua-x' } });
    expect(cfg.fingerprint).toEqual({ enabled: true, ua: 'ua-x' });
  });

  it('mergeServerConfig replaces the fingerprint segment on a PUT, keeps it otherwise', () => {
    const current = normalizeServerConfig({ fingerprint: { enabled: true, ua: 'a' } });
    expect(mergeServerConfig(current, {}).fingerprint).toEqual({ enabled: true, ua: 'a' });
    expect(mergeServerConfig(current, { fingerprint: { enabled: false } }).fingerprint).toEqual({ enabled: false });
  });
});
