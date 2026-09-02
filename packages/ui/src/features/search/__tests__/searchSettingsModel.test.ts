import { describe, expect, it } from 'vitest';

import type { SearchDiagnosticsSnapshot, SearchServerConfig } from '@/daemon/types';

import {
  clampMaxAttemptsInput,
  createSearchSettingsDraft,
  draftProviderConfigured,
  isUsableHostString,
  pendingRestartProviderIds,
  SEARCH_PROVIDER_CATALOG,
  searchDraftToPayload,
} from '../searchSettingsModel';

function maskedRead(overrides: Partial<SearchServerConfig> = {}): SearchServerConfig {
  return {
    modes: { codex: 'off', responses: 'native', anthropic: 'native' },
    providers: {},
    egress: { allowedPrivateHosts: [] },
    policy: { fallbackEnabled: true },
    ...overrides,
  };
}

describe('the provider catalog is closed at the seven built-ins', () => {
  it('lists exactly the seven Phase-1 ids in display order', () => {
    expect(SEARCH_PROVIDER_CATALOG.map((entry) => entry.id)).toEqual([
      'http-bing',
      'http-duckduckgo',
      'tavily',
      'jina',
      'searxng',
      'zhipu',
      'z.ai',
    ]);
  });

  it('contains no local-*, grok, claude, exa, or bocha id anywhere', () => {
    const serialized = JSON.stringify(SEARCH_PROVIDER_CATALOG).toLowerCase();
    expect(serialized).not.toContain('local-');
    expect(serialized).not.toContain('grok');
    expect(serialized).not.toContain('claude');
    expect(serialized).not.toContain('"exa"');
    expect(serialized).not.toContain('bocha');
  });
});

describe('createSearchSettingsDraft', () => {
  it('seeds from a masked read without any secret value', () => {
    const masked = maskedRead({
      providers: {
        tavily: { apiKeyConfigured: true },
        searxng: {
          apiHost: 'https://searx.internal.example.test',
          basicAuthUsername: 'svc',
          basicAuthPasswordConfigured: true,
        },
        jina: { apiKeyConfigured: false },
      },
      policy: { preferred: 'tavily', fallbackEnabled: false, maxAttempts: 4 },
      egress: { allowedPrivateHosts: ['searx.internal.example.test'] },
    });
    const draft = createSearchSettingsDraft(masked);
    expect(draft.providers.tavily?.persistedConfigured).toBe(true);
    expect(draft.providers.tavily?.apiKeyInput).toBe('');
    expect(draft.providers.searxng?.apiHost).toBe('https://searx.internal.example.test');
    expect(draft.providers.searxng?.basicAuthUsername).toBe('svc');
    expect(draft.providers.jina?.persistedConfigured).toBe(true);
    expect(draft.policy).toEqual({ preferred: 'tavily', allowed: [], fallbackEnabled: false, maxAttempts: '4' });
    expect(draft.allowedPrivateHosts).toEqual(['searx.internal.example.test']);
  });

  it('tolerates an absent section (pre-Phase-1 daemon) with defaults', () => {
    const draft = createSearchSettingsDraft(undefined);
    expect(draft.modes).toEqual({ codex: 'off', responses: 'native', anthropic: 'native' });
    expect(Object.keys(draft.providers)).toEqual(['tavily', 'jina', 'searxng', 'zhipu', 'z.ai']);
    expect(draft.policy.fallbackEnabled).toBe(true);
  });
});

describe('searchDraftToPayload', () => {
  it('omits blank secret fields so the daemon preserves stored values', () => {
    const draft = createSearchSettingsDraft(maskedRead({
      providers: { tavily: { apiKeyConfigured: true } },
    }));
    const payload = searchDraftToPayload(draft);
    expect(payload.providers.tavily).toEqual({});
    expect(payload.providers).not.toHaveProperty('apiKey');
  });

  it('sets a typed key, host override, and basic-auth password', () => {
    const draft = createSearchSettingsDraft(maskedRead());
    draft.providers.tavily!.apiKeyInput = '  NEW_KEY  ';
    draft.providers.tavily!.apiHost = 'https://tavily-mirror.example.test';
    draft.providers.searxng!.apiHost = 'https://searx.internal.example.test';
    draft.providers.searxng!.basicAuthUsername = 'svc';
    draft.providers.searxng!.basicAuthPasswordInput = 'pw';

    const payload = searchDraftToPayload(draft);
    expect(payload.providers.tavily).toEqual({
      apiKey: 'NEW_KEY',
      apiHost: 'https://tavily-mirror.example.test',
    });
    expect(payload.providers.searxng).toEqual({
      apiHost: 'https://searx.internal.example.test',
      basicAuthUsername: 'svc',
      basicAuthPassword: 'pw',
    });
  });

  it('clears an optional secret with JSON null and keeps the entry alive', () => {
    const draft = createSearchSettingsDraft(maskedRead({
      providers: { jina: { apiKeyConfigured: true } },
    }));
    draft.providers.jina!.clearApiKey = true;
    draft.providers.searxng!.apiHost = 'https://searx.internal.example.test';
    draft.providers.searxng!.clearBasicAuthPassword = true;

    const payload = searchDraftToPayload(draft);
    expect(payload.providers.jina).toEqual({ apiKey: null });
    expect(payload.providers.searxng).toEqual({
      apiHost: 'https://searx.internal.example.test',
      basicAuthPassword: null,
    });
  });

  it('removes the entry entirely for a removed provider (the required-key clear)', () => {
    const draft = createSearchSettingsDraft(maskedRead({
      providers: { tavily: { apiKeyConfigured: true }, zhipu: { apiKeyConfigured: true } },
    }));
    draft.providers.tavily!.removed = true;
    const payload = searchDraftToPayload(draft);
    expect(payload.providers.tavily).toBeUndefined();
    expect(payload.providers.zhipu).toEqual({}); // untouched entry survives
  });

  it('never sends null for a REQUIRED key (removal is the only clear)', () => {
    const draft = createSearchSettingsDraft(maskedRead());
    draft.providers.zhipu!.clearApiKey = true; // defensive: the UI never offers this
    const payload = searchDraftToPayload(draft);
    // An unconfigured required-key entry with no typed key is omitted outright
    // (configure-state IS enablement) — and `null` is never the payload form.
    expect(payload.providers.zhipu).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('null');
  });

  it('omits searxng without a usable host (unconfigured, not an error)', () => {
    const draft = createSearchSettingsDraft(maskedRead());
    draft.providers.searxng!.apiHost = '   ';
    const payload = searchDraftToPayload(draft);
    expect(payload.providers.searxng).toBeUndefined();
  });

  it('keeps a keyless jina entry as an explicit enable', () => {
    const draft = createSearchSettingsDraft(maskedRead());
    const payload = searchDraftToPayload({ ...draft, providers: { ...draft.providers, jina: { ...draft.providers.jina!, persistedConfigured: true } } });
    expect(payload.providers.jina).toEqual({});
  });

  it('omits EVERY provider entry on an untouched fresh draft — a no-op save enables nothing and never 400s', () => {
    const draft = createSearchSettingsDraft(maskedRead());
    const payload = searchDraftToPayload(draft);
    expect(payload.providers).toEqual({});
    // The daemon-side validator agrees: nothing to reject.
    expect(payload).toMatchObject({ policy: { fallbackEnabled: true } });
  });

  it('enables keyless jina by naming a host, not by sending an empty entry', () => {
    const draft = createSearchSettingsDraft(maskedRead());
    draft.providers.jina!.apiHost = 'https://s.jina.example.test';
    const payload = searchDraftToPayload(draft);
    expect(payload.providers.jina).toEqual({ apiHost: 'https://s.jina.example.test' });
  });

  it('clamps maxAttempts into 1..32, drops unusable hosts, filters unknown policy ids', () => {
    const draft = createSearchSettingsDraft(maskedRead());
    draft.policy.maxAttempts = '100';
    draft.policy.preferred = 'grok';
    draft.policy.allowed = ['tavily', 'grok'];
    draft.allowedPrivateHosts = ['ok.internal.example.test', '  ', 'bad\x01host'];

    const payload = searchDraftToPayload(draft);
    expect(payload.policy.maxAttempts).toBe(32);
    expect(payload.policy.preferred).toBeUndefined();
    expect(payload.policy.allowed).toEqual(['tavily']);
    expect(payload.egress.allowedPrivateHosts).toEqual(['ok.internal.example.test']);
  });
});

describe('client-side clamps', () => {
  it('clamps maxAttempts input', () => {
    expect(clampMaxAttemptsInput('0')).toBe(1);
    expect(clampMaxAttemptsInput('100')).toBe(32);
    expect(clampMaxAttemptsInput(' 5 ')).toBe(5);
    expect(clampMaxAttemptsInput('4.7')).toBe(5);
    expect(clampMaxAttemptsInput('')).toBeUndefined();
    expect(clampMaxAttemptsInput('abc')).toBeUndefined();
  });

  it('rejects control characters and over-long hosts', () => {
    expect(isUsableHostString('https://searx.example.test')).toBe(true);
    expect(isUsableHostString('  ')).toBe(false);
    expect(isUsableHostString('bad\x02host')).toBe(false);
    expect(isUsableHostString('x'.repeat(2049))).toBe(false);
  });
});

describe('pendingRestartProviderIds', () => {
  function diagnostics(rows: string[]): SearchDiagnosticsSnapshot {
    return {
      rows: rows.map((providerId) => ({
        providerId,
        source: 'builtin' as const,
        kind: 'api' as const,
        capabilities: {
          requiresApiKey: false,
          supportsCancellation: true,
          supportsUrlRead: false,
          supportsRegion: false,
          supportsLanguage: false,
          supportsTimeRange: false,
        },
      })),
      modes: { codex: 'off', responses: 'native', anthropic: 'native' },
      applySemantics: { codex: 'immediate', rest: 'restart' },
    };
  }

  it('names providers saved after boot (persisted but not running, unconfigured rows ignored)', () => {
    const persisted = maskedRead({ providers: { tavily: { apiKeyConfigured: true }, jina: {} } });
    // Runtime rows: the http pair runs; jina/searxng/zhipu/z.ai appear as
    // UNCONFIGURED rows, which are NOT running — only tavily+jina (persisted)
    // diverge from the running set.
    const snapshot = diagnostics(['http-bing', 'http-duckduckgo']);
    const rows = [
      ...snapshot.rows,
      ...['jina', 'searxng', 'zhipu', 'z.ai'].map((providerId) => ({
        providerId, source: 'builtin' as const, kind: 'api' as const, status: 'unconfigured' as const,
        capabilities: {} as never,
      })),
    ];
    expect(pendingRestartProviderIds(persisted, { ...snapshot, rows })).toEqual(['tavily', 'jina']);
  });

  it('names providers removed from config but still running', () => {
    const persisted = maskedRead();
    expect(
      pendingRestartProviderIds(persisted, diagnostics(['http-bing', 'http-duckduckgo', 'tavily'])),
    ).toEqual(['tavily']);
  });

  it('reports nothing on a converged config or an older daemon', () => {
    const persisted = maskedRead({ providers: { tavily: { apiKeyConfigured: true } } });
    expect(pendingRestartProviderIds(persisted, diagnostics(['http-bing', 'http-duckduckgo', 'tavily']))).toEqual([]);
    expect(pendingRestartProviderIds(persisted, null)).toEqual([]);
  });
});

describe('draftProviderConfigured', () => {
  const byId = new Map(SEARCH_PROVIDER_CATALOG.map((entry) => [entry.id, entry]));

  it('is always true for the keyless http pair', () => {
    const draft = createSearchSettingsDraft(undefined);
    expect(draftProviderConfigured(byId.get('http-bing')!, { ...draft.providers.tavily! })).toBe(true);
  });

  it('tracks unconfigured → configured via a typed key or host', () => {
    const draft = createSearchSettingsDraft(undefined);
    expect(draftProviderConfigured(byId.get('tavily')!, draft.providers.tavily!)).toBe(false);
    draft.providers.tavily!.apiKeyInput = 'k';
    expect(draftProviderConfigured(byId.get('tavily')!, draft.providers.tavily!)).toBe(true);
    expect(draftProviderConfigured(byId.get('searxng')!, draft.providers.searxng!)).toBe(false);
    draft.providers.searxng!.apiHost = 'https://searx.example.test';
    expect(draftProviderConfigured(byId.get('searxng')!, draft.providers.searxng!)).toBe(true);
  });
});
