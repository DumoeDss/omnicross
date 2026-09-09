import { describe, expect, it } from 'vitest';

import type { ImagesCapabilityStatus } from '@/daemon/types';

import { providerCardRows } from '../providerCardModel';

function capability(over: Partial<ImagesCapabilityStatus> = {}): ImagesCapabilityStatus {
  return {
    configured: {
      enabled: true,
      provider: 'codex-subscription',
      model: 'gpt-image-2',
      remoteUrlsEnabled: false,
      referenceTtlMs: 86_400_000,
    },
    providers: [
      {
        providerId: 'antigravity-subscription',
        available: true,
        reason: null,
        models: ['gemini-3-pro-image-preview'],
        evidence: { verifiedAt: 1_000, ageMs: 2_500 },
      },
      {
        providerId: 'codex-subscription',
        available: true,
        reason: null,
        models: ['gpt-image-2', 'gpt-image-2-5'],
        evidence: { verifiedAt: 1_000, ageMs: 60_000 },
      },
    ],
    effective: {
      available: true,
      reason: null,
      evidence: null,
      features: {} as ImagesCapabilityStatus['effective']['features'],
    },
    runtime: {
      disposed: false,
      generationId: 'g',
      drainingCount: 0,
      draining: [],
    },
    endpoints: null,
    lanEndpoints: null,
    ...over,
  } as ImagesCapabilityStatus;
}

describe('providerCardRows (images-settings-tab D2)', () => {
  it('orders the default provider first and labels providers', () => {
    const rows = providerCardRows(capability());
    expect(rows.map((row) => row.providerId)).toEqual([
      'codex-subscription',
      'antigravity-subscription',
    ]);
    expect(rows[0].label).toBe('Codex');
    expect(rows[1].label).toBe('Antigravity');
    expect(rows[0].models).toEqual(['gpt-image-2', 'gpt-image-2-5']);
  });

  it('marks an available antigravity row without evidence as bootstrap-unverified', () => {
    const rows = providerCardRows({
      ...capability(),
      providers: [
        {
          providerId: 'antigravity-subscription',
          available: true,
          reason: null,
          models: ['gemini-3-pro-image-preview'],
          evidence: null,
        },
      ],
      configured: {
        enabled: true,
        provider: 'antigravity-subscription',
        model: 'gemini-3-pro-image-preview',
        remoteUrlsEnabled: false,
        referenceTtlMs: 86_400_000,
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].available).toBe(true);
    expect(rows[0].unverified).toBe(true);
    expect(rows[0].evidenceAgeSeconds).toBeUndefined();
  });

  it('does not flag an evidenced or a codex row as unverified', () => {
    const rows = providerCardRows(capability());
    expect(rows[0].unverified).toBe(false); // codex, evidence present
    expect(rows[1].unverified).toBe(false); // antigravity WITH evidence
    expect(rows[1].evidenceAgeSeconds).toBe(2);
  });

  it('carries the safe reason through on unavailable rows', () => {
    const rows = providerCardRows({
      ...capability(),
      providers: [
        {
          providerId: 'antigravity-subscription',
          available: false,
          reason: 'account_unverified',
          models: [],
          evidence: null,
        },
      ],
    });
    expect(rows[0].available).toBe(false);
    expect(rows[0].reason).toBe('account_unverified');
    expect(rows[0].unverified).toBe(false);
  });

  it('returns empty for null capability or a daemon predating providers', () => {
    expect(providerCardRows(null)).toEqual([]);
    expect(providerCardRows({ ...capability(), providers: undefined })).toEqual([]);
  });
});
