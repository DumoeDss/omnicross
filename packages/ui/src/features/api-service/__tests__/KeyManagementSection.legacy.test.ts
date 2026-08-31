import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/state/LocaleContext', () => ({
  useTranslation: () => (key: string) => key,
}));

import type { OutboundApiKeyInfo } from '@/daemon/types';

import { KeyManagementSection } from '../KeyManagementSection';

function key(legacyPermissions: boolean): OutboundApiKeyInfo {
  return {
    id: legacyPermissions ? 'legacy-key' : 'explicit-key',
    name: legacyPermissions ? 'Legacy key' : 'Explicit key',
    keyPrefix: 'oc_safe',
    enabled: true,
    createdAt: 1,
    lastUsedAt: null,
    revoked: false,
    allowedEndpoints: ['chat', 'responses', 'messages', 'gemini'],
    legacyPermissions,
  };
}

function render(row: OutboundApiKeyInfo): string {
  return renderToStaticMarkup(React.createElement(KeyManagementSection, {
    keys: [row],
    busy: false,
    createdKey: null,
    onCreate: async () => true,
    onReveal: async () => ({ success: false }),
    onRevoke: async () => undefined,
    onDelete: async () => undefined,
    onToggle: async () => undefined,
    onSetMaxConcurrency: async () => undefined,
    onSetPermissions: async () => undefined,
    onSetPolicy: async () => undefined,
    onDismissCreated: () => undefined,
  }));
}

describe('KeyManagementSection legacy permission badge', () => {
  it('renders only from the explicit daemon marker while preserving effective checkboxes', () => {
    const legacy = render(key(true));
    const explicit = render(key(false));

    expect(legacy).toContain('apiService.keys.permissions.legacy');
    expect(legacy).toContain('apiService.keys.permissions.chat');
    expect(legacy).toContain('apiService.keys.permissions.images');
    expect(explicit).not.toContain('apiService.keys.permissions.legacy');
  });

  it('shows bound CLI usage without exposing a token', () => {
    const row = { ...key(false), revealable: true };
    const html = renderToStaticMarkup(React.createElement(KeyManagementSection, {
      keys: [row],
      busy: false,
      createdKey: null,
      onCreate: async () => true,
      onReveal: async () => ({ success: false }),
      onRevoke: async () => undefined,
      onDelete: async () => undefined,
      onToggle: async () => undefined,
      onSetMaxConcurrency: async () => undefined,
      onSetPermissions: async () => undefined,
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
