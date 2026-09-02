import { describe, expect, it } from 'vitest';

import { validateSearchServerConfig } from '@omnicross/core/outbound-api';
import type { SearchServerConfig } from '@omnicross/core/outbound-api/types';

import {
  preserveSearchSecrets,
  redactSearchServerConfig,
} from '../searchAdminView';

const KEY_SENTINEL = 'SEARCH_KEY_SENTINEL_do_not_echo';
const PASSWORD_SENTINEL = 'SEARCH_PASSWORD_SENTINEL_do_not_echo';

function plantedConfig(): SearchServerConfig {
  return {
    modes: { codex: 'off', responses: 'native', anthropic: 'native' },
    providers: {
      tavily: { apiKey: KEY_SENTINEL },
      jina: { apiHost: 'https://s.jina.example.test' },
      searxng: {
        apiHost: 'https://searx.internal.example.test',
        basicAuthUsername: 'svc',
        basicAuthPassword: PASSWORD_SENTINEL,
      },
      zhipu: { apiKey: KEY_SENTINEL, apiHost: 'https://open.bigmodel.example.test' },
    },
    egress: { allowedPrivateHosts: ['searx.internal.example.test'] },
    policy: { preferred: 'tavily', fallbackEnabled: true, maxAttempts: 3 },
  };
}

describe('redactSearchServerConfig', () => {
  it('never serializes a secret value and replaces it with presence markers', () => {
    const view = redactSearchServerConfig(plantedConfig());
    const serialized = JSON.stringify(view);

    expect(serialized).not.toContain(KEY_SENTINEL);
    expect(serialized).not.toContain(PASSWORD_SENTINEL);
    expect(view.providers.tavily).toEqual({ apiKeyConfigured: true });
    expect(view.providers.zhipu).toEqual({
      apiKeyConfigured: true,
      apiHost: 'https://open.bigmodel.example.test',
    });
  });

  it('keeps non-secret members round-tripping and reads a missing secret as marker-false', () => {
    const view = redactSearchServerConfig(plantedConfig());

    // jina is configured keyless → apiKeyConfigured FALSE, not absent.
    expect(view.providers.jina).toEqual({
      apiHost: 'https://s.jina.example.test',
      apiKeyConfigured: false,
    });
    // searxng keeps host + username, password becomes a marker.
    expect(view.providers.searxng).toEqual({
      apiHost: 'https://searx.internal.example.test',
      basicAuthUsername: 'svc',
      basicAuthPasswordConfigured: true,
    });
    expect(view.modes).toEqual({ codex: 'off', responses: 'native', anthropic: 'native' });
    expect(view.egress.allowedPrivateHosts).toEqual(['searx.internal.example.test']);
    expect(view.policy).toEqual({ preferred: 'tavily', fallbackEnabled: true, maxAttempts: 3 });
  });

  it('reads a searxng entry without a password as basicAuthPasswordConfigured false', () => {
    const config = plantedConfig();
    delete config.providers.searxng?.basicAuthPassword;
    const view = redactSearchServerConfig(config);
    expect(view.providers.searxng).toEqual({
      apiHost: 'https://searx.internal.example.test',
      basicAuthUsername: 'svc',
      basicAuthPasswordConfigured: false,
    });
  });
});

describe('preserveSearchSecrets', () => {
  it('keeps the stored key when the patch omits it (editing the host never wipes a key)', () => {
    const preserved = preserveSearchSecrets(
      {
        providers: {
          searxng: {
            apiHost: 'https://searx2.internal.example.test',
            basicAuthUsername: 'svc2',
            // marker-only: no basicAuthPassword field
            basicAuthPasswordConfigured: true,
          },
          tavily: { apiKeyConfigured: true },
        },
      },
      plantedConfig(),
    ) as { providers: Record<string, Record<string, unknown>> };

    expect(preserved.providers.searxng).toEqual({
      apiHost: 'https://searx2.internal.example.test',
      basicAuthUsername: 'svc2',
      basicAuthPassword: PASSWORD_SENTINEL,
    });
    // Omitted required key + marker stripped → the stored key is re-attached.
    expect(preserved.providers.tavily).toEqual({ apiKey: KEY_SENTINEL });
    expect(JSON.stringify(preserved)).not.toContain('Configured');
  });

  it('sets on a non-empty string and keeps on a blank string', () => {
    const preserved = preserveSearchSecrets(
      {
        providers: {
          tavily: { apiKey: 'NEW_KEY_VALUE' },
          jina: { apiKey: '' },
        },
      },
      plantedConfig(),
    ) as { providers: Record<string, Record<string, unknown>> };

    expect(preserved.providers.tavily).toEqual({ apiKey: 'NEW_KEY_VALUE' });
    // jina had NO stored key and a blank arrives → the field is dropped (a
    // blank was never a value), and the keyless entry survives.
    expect(preserved.providers.jina).toEqual({});
  });

  it('keeps a stored optional secret on blank input', () => {
    const preserved = preserveSearchSecrets(
      { providers: { searxng: { apiHost: 'https://searx.internal.example.test', basicAuthPassword: '   ' } } },
      plantedConfig(),
    ) as { providers: Record<string, Record<string, unknown>> };

    expect(preserved.providers.searxng?.basicAuthPassword).toBe(PASSWORD_SENTINEL);
  });

  it('clears an optional secret on JSON null while the entry survives', () => {
    const preserved = preserveSearchSecrets(
      {
        providers: {
          jina: { apiKey: null },
          searxng: { apiHost: 'https://searx.internal.example.test', basicAuthPassword: null },
        },
      },
      { ...plantedConfig(), providers: { ...plantedConfig().providers, jina: { apiKey: KEY_SENTINEL } } },
    ) as { providers: Record<string, Record<string, unknown>> };

    expect(preserved.providers.jina).toEqual({});
    expect(preserved.providers.searxng).not.toHaveProperty('basicAuthPassword');
  });

  it('removes a null-cleared REQUIRED key so validateSearchServerConfig rejects the entry', () => {
    const preserved = preserveSearchSecrets(
      { providers: { zhipu: { apiKey: null } } },
      plantedConfig(),
    );

    const errors = validateSearchServerConfig(preserved);
    expect(errors).toEqual(['$.search.providers.zhipu.apiKey: missing or unusable']);
  });

  it('does not resurrect a provider entry the patch removed', () => {
    const preserved = preserveSearchSecrets(
      { providers: { jina: {} } },
      plantedConfig(),
    ) as { providers: Record<string, unknown> };

    expect(Object.keys(preserved.providers)).toEqual(['jina']);
  });

  it('passes non-object segments through for the validator to reject', () => {
    expect(preserveSearchSecrets('nope', plantedConfig())).toBe('nope');
    expect(preserveSearchSecrets(undefined, plantedConfig())).toBeUndefined();
  });
});
