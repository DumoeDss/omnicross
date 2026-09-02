/** @vitest-environment jsdom */

/**
 * SearchSettingsSection sentinel tests (moved from api-service; the section is
 * the standalone Search page's body since search-settings-tab): the closed
 * seven-id catalog renders with no dead/local ids, the unconfigured state is
 * an honest empty state (now WITH the always-reachable entry fields — the D3
 * fix), and a planted secret NEVER renders — not as text, not as an attribute,
 * not in a placeholder.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/state/LocaleContext', () => ({
  // Identity t(), with interpolation values appended so parametrized strings
  // are observable in the static markup.
  useTranslation: () => (key: string, opts?: Record<string, unknown>) =>
    opts && Object.keys(opts).length > 0
      ? `${key}:${Object.values(opts).map(String).join(',')}`
      : key,
}));

import type {
  SearchDiagnosticsSnapshot,
  SearchQueryOutcome,
  SearchServerConfig,
} from '@/daemon/types';

import { SearchSettingsSection } from '../SearchSettingsSection';

/** A masked read carrying a PLANTED secret value — exactly what the daemon must
 *  never send but the sentinel guards against anyway. */
const configWithSecret = {
  modes: { codex: 'off', responses: 'native', anthropic: 'native' },
  providers: {
    tavily: { apiKey: 'SECRET_SENTINEL', apiKeyConfigured: true },
    searxng: {
      apiHost: 'https://searx.internal.example.test',
      basicAuthUsername: 'svc',
      basicAuthPassword: 'PASSWORD_SENTINEL',
      basicAuthPasswordConfigured: true,
    },
    jina: { apiKeyConfigured: false },
  },
  egress: { allowedPrivateHosts: ['searx.internal.example.test'] },
  policy: { preferred: 'tavily', fallbackEnabled: true },
} as unknown as SearchServerConfig;

const diagnostics: SearchDiagnosticsSnapshot = {
  rows: [
    { providerId: 'http-bing', source: 'builtin', kind: 'http', capabilities: { requiresApiKey: false, supportsCancellation: true, supportsUrlRead: false, supportsRegion: false, supportsLanguage: false, supportsTimeRange: false } },
    { providerId: 'http-duckduckgo', source: 'builtin', kind: 'http', capabilities: { requiresApiKey: false, supportsCancellation: true, supportsUrlRead: false, supportsRegion: false, supportsLanguage: false, supportsTimeRange: false } },
    { providerId: 'tavily', source: 'builtin', kind: 'api', capabilities: { requiresApiKey: true, supportsCancellation: true, supportsUrlRead: false, supportsRegion: false, supportsLanguage: false, supportsTimeRange: false } },
    { providerId: 'jina', source: 'builtin', kind: 'api', status: 'unconfigured', reason: 'not configured', capabilities: { requiresApiKey: false, supportsCancellation: true, supportsUrlRead: true, supportsRegion: false, supportsLanguage: false, supportsTimeRange: false } },
    { providerId: 'searxng', source: 'builtin', kind: 'api', status: 'unconfigured', reason: 'no API host configured', capabilities: { requiresApiKey: false, supportsCancellation: true, supportsUrlRead: false, supportsRegion: false, supportsLanguage: false, supportsTimeRange: false } },
    { providerId: 'zhipu', source: 'builtin', kind: 'api', status: 'unconfigured', reason: 'no API key configured', capabilities: { requiresApiKey: true, supportsCancellation: true, supportsUrlRead: false, supportsRegion: false, supportsLanguage: false, supportsTimeRange: false } },
    { providerId: 'z.ai', source: 'builtin', kind: 'api', status: 'unconfigured', reason: 'no API key configured', capabilities: { requiresApiKey: true, supportsCancellation: true, supportsUrlRead: false, supportsRegion: false, supportsLanguage: false, supportsTimeRange: false } },
  ],
  modes: { codex: 'off', responses: 'native', anthropic: 'native' },
  applySemantics: { codex: 'immediate', rest: 'restart' },
};

const unusedQuery = async (): Promise<SearchQueryOutcome> => ({ ok: false, error: 'unused' });

describe('SearchSettingsSection sensitive DTO rendering', () => {
  it('renders the seven-card catalog and never the planted secret material', () => {
    const markup = renderToStaticMarkup(
      React.createElement(SearchSettingsSection, {
        config: configWithSecret,
        diagnostics,
        busy: false,
        onUpdate: async () => undefined,
        onQuery: unusedQuery,
      }),
    );

    // The closed seven-id catalog renders, with no dead/local ids.
    for (const name of ['Bing (HTTP)', 'DuckDuckGo (HTTP)', 'Tavily', 'Jina', 'SearXNG', 'Zhipu', 'Z.AI']) {
      expect(markup).toContain(name);
    }
    expect(markup).not.toContain('grok');
    expect(markup.toLowerCase()).not.toContain('local-');
    expect(markup).not.toContain('bocha');
    expect(markup).not.toContain('claude');

    // Unconfigured is an honest empty state naming the missing field.
    expect(markup).toContain('search.unconfiguredReason.zai');

    // NEVER the secret material — not in text, not in an attribute, not in a
    // placeholder (the write-only inputs are empty by construction).
    expect(markup).not.toContain('SECRET_SENTINEL');
    expect(markup).not.toContain('PASSWORD_SENTINEL');
  });

  it('renders the unsupported notice (not an error) on a pre-Phase-1 daemon', () => {
    const markup = renderToStaticMarkup(
      React.createElement(SearchSettingsSection, {
        config: undefined,
        diagnostics: null,
        busy: false,
        onUpdate: async () => undefined,
        onQuery: unusedQuery,
      }),
    );
    expect(markup).toContain('search.unsupportedDaemon');
  });

  it('renders the pending-restart banner naming saved-but-not-running providers', () => {
    // Persisted carries tavily+zhipu; the RUNNING runtime rows only include the
    // http pair → both diverge → banner names them.
    const persisted = {
      ...configWithSecret,
      providers: {
        tavily: { apiKeyConfigured: true },
        zhipu: { apiKeyConfigured: true },
      },
    } as unknown as SearchServerConfig;
    const runningOnly: SearchDiagnosticsSnapshot = {
      ...diagnostics,
      rows: diagnostics.rows.filter((row) => row.kind === 'http'),
    };
    const markup = renderToStaticMarkup(
      React.createElement(SearchSettingsSection, {
        config: persisted,
        diagnostics: runningOnly,
        busy: false,
        onUpdate: async () => undefined,
        onQuery: unusedQuery,
      }),
    );
    expect(markup).toContain('search.restartBanner:Tavily, Zhipu');
  });

  it('labels the codex mode immediate and the other restart-required fields', () => {
    const markup = renderToStaticMarkup(
      React.createElement(SearchSettingsSection, {
        config: configWithSecret,
        diagnostics,
        busy: false,
        onUpdate: async () => undefined,
        onQuery: unusedQuery,
      }),
    );
    expect(markup).toContain('search.immediateHint');
    expect(markup).toContain('search.restartHint');
  });
});
