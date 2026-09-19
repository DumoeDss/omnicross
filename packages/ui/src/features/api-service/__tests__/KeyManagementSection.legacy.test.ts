import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/state/LocaleContext', () => ({
  useTranslation: () => (key: string) => key,
}));

import type { OutboundApiKeyInfo } from '@/daemon/types';

import { KeyManagementSection } from '../KeyManagementSection';

function key(): OutboundApiKeyInfo {
  return {
    id: 'explicit-key',
    name: 'Explicit key',
    keyPrefix: 'oc_safe',
    enabled: true,
    createdAt: 1,
    lastUsedAt: null,
    revoked: false,
    allowedEndpoints: ['chat', 'responses', 'messages', 'gemini', 'images'],
  };
}

describe('KeyManagementSection', () => {
  it('shows bound CLI usage without exposing a token', () => {
    const row = { ...key(), revealable: true };
    const html = renderToStaticMarkup(React.createElement(KeyManagementSection, {
      keys: [row],
      busy: false,
      createdKey: null,
      onCreate: async () => true,
      onReveal: async () => ({ success: false }),
      onRevoke: async () => undefined,
      onToggle: async () => undefined,
      onSetMaxConcurrency: async () => undefined,
      onSetPolicy: async () => undefined,
      onDismissCreated: () => undefined,
      onBindIntegration: async () => ({ success: true }),
      integrations: [{
        client: 'codex',
        status: 'enabled',
        configPath: 'config.toml',
        key: {
          id: row.id,
          name: row.name,
          keyPrefix: row.keyPrefix,
          ownership: 'selected',
          revealable: true,
          enabled: true,
          revoked: false,
          allowedEndpoints: ['responses', 'images'],
          requiredEndpoints: ['responses', 'images'],
          loopbackOnly: false,
        },
      }],
    }));

    expect(html).toContain('apiService.keys.integrations.inUse');
    expect(html).toContain('apiService.keys.integrations.useFor');
    expect(html).not.toContain('sk-omnicross-secret');
  });
});
