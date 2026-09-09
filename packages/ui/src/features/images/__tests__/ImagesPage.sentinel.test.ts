import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/state/LocaleContext', () => ({
  useTranslation: () => (key: string) => key,
}));

vi.mock('../hooks/useImagesSettings', () => ({
  useImagesSettings: () => ({
    loading: false,
    config: {
      enabled: true,
      models: {
        'gpt-image-2': 'codex-subscription',
        'gemini-3-pro-image-preview': 'antigravity-subscription',
      },
      defaultModel: 'gpt-image-2',
      aliases: {},
      codex: { imageModel: 'gpt-image-2', carrierModel: 'gpt-5.6-luna' },
      account: { fallback: 'strict' },
      references: { storageRootConfigured: true },
      remote: { enabled: false },
    },
    capability: {
      configured: {
        enabled: true,
        provider: 'codex-subscription',
        model: 'gpt-image-2',
        remoteUrlsEnabled: false,
        referenceTtlMs: 86_400_000,
      },
      providers: [
        {
          providerId: 'codex-subscription',
          available: true,
          reason: null,
          models: ['gpt-image-2'],
          evidence: { verifiedAt: 1_000, ageMs: 2_000 },
        },
        {
          providerId: 'antigravity-subscription',
          available: true,
          reason: null,
          models: ['gemini-3-pro-image-preview'],
          evidence: null,
        },
      ],
      effective: {
        available: true,
        reason: null,
        evidence: null,
        features: {},
      },
      runtime: { disposed: false, generationId: 'g', drainingCount: 0, draining: [] },
      endpoints: null,
      lanEndpoints: null,
    },
    status: null,
    accounts: {
      accounts: [],
      providerAccounts: {
        claude: [], codex: [], gemini: [], opencodego: [],
        kimi: [], grok: [], copilot: [], antigravity: [],
      },
    },
    busy: false,
    error: null,
    updateImagesConfig: async () => undefined,
    verifyImagesLive: async () => null,
    refresh: async () => undefined,
  }),
}));

import type { ImagesServerConfig } from '@/daemon/types';

import { ImagesPage } from '../ImagesPage';

describe('ImagesPage rendering (images-settings-tab)', () => {
  it('renders per-provider cards, the verify panel, and the migrated section without secrets', () => {
    const markup = renderToStaticMarkup(React.createElement(ImagesPage));
    // Per-provider cards (one per routed provider) and the verify panel.
    expect(markup).toContain('image-provider-codex-subscription');
    expect(markup).toContain('image-provider-antigravity-subscription');
    expect(markup).toContain('image-verify-panel');
    // The migrated section's route table rides the page.
    expect(markup).toContain('image-route-table');
    // The honest bootstrap label for the evidence-less antigravity row.
    expect(markup).toContain('images.providers.bootstrap');
    // No secret-ish sentinels anywhere in the page markup.
    for (const sentinel of ['RAW_ACCOUNT_ID_SENTINEL', 'BASE64_SENTINEL', 'PRIVATE_PATH_SENTINEL']) {
      expect(markup).not.toContain(sentinel);
    }
  });

  it('types compile against the routing-table config shape', () => {
    const config: ImagesServerConfig = {
      enabled: false,
      models: { 'gpt-image-2': 'codex-subscription' },
      defaultModel: 'gpt-image-2',
      aliases: {},
      codex: { imageModel: 'gpt-image-2', carrierModel: 'gpt-5.6-luna' },
      account: { fallback: 'strict' },
      queue: {
        maxConcurrentJobsPerAccount: 1,
        maxQueuedJobs: 20,
        queueTimeoutMs: 120_000,
        generationTimeoutMs: 180_000,
      },
      temporary: {
        maxActiveScopes: 64,
        maxTotalBytes: 1024 ** 3,
        maxTenantBytes: 256 * 1024 ** 2,
        staleAfterMs: 3_600_000,
        cleanupIntervalMs: 300_000,
      },
      limits: {} as ImagesServerConfig['limits'],
      references: { ttlMs: 86_400_000 } as ImagesServerConfig['references'],
      remote: { enabled: false },
      evidenceTtlMs: 604_800_000,
    };
    expect(config.models['gpt-image-2']).toBe('codex-subscription');
  });
});
