/**
 * Unit tests for the Codex CLI launch-config builder (`codex-proxy-env.ts`).
 *
 * Section 5 of the `codex-responses-ingress` OpenSpec change. Covers:
 *  (a) `buildCodexConfigOverrides` — the load-bearing `-c key=value` contract:
 *      the exact TOML keys + types the Codex CLI must receive to be redirected
 *      at the proxy (`model_provider`, `model_providers.<name>.base_url`,
 *      `wire_api="responses"`, UNQUOTED `requires_openai_auth=true`,
 *      `disable_response_storage=true`), with the listener base path appended.
 *  (b) `buildCodexLaunchConfig` (BYO) — drives a real resident `ProviderProxy`, returns
 *      `{ env, extraArgs, baseUrl, onSessionEnd }`; the overrides embed the
 *      booted port; the auth sentinel is set; `onSessionEnd` stops the listener.
 *  (c) error semantics — missing provider / missing key (BYO) and missing
 *      subscription profile (subscription) throw BEFORE any listener is booted.
 *
 * NOT E2E-verifiable here: there is no real Codex CLI binary and no real ChatGPT
 * subscription in this environment, so "the real Codex CLI connects to the
 * listener and round-trips a turn" must be verified by the user against a real
 * Codex CLI. These tests prove the builder's CONTRACT (config block + lifecycle).
 *
 * @module proxy-env/__tests__/codex-proxy-env.test
 */

import type { ProviderConfigSource } from '@omnicross/core';
import type { SubscriptionAuthProfile } from '@omnicross/core/pipeline/SubscriptionAuthSource';
import { __resetProviderProxyForTests, getProviderProxy } from '@omnicross/core/provider-proxy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildCodexConfigOverrides,
  buildCodexLaunchConfig,
  CODEX_PROXY_BASE_PATH,
  CODEX_PROXY_PROVIDER_NAME,
} from '../codex-proxy-env';

const fakeProvider = {
  id: 'openai-prov',
  name: 'OpenAI',
  apiFormat: 'openai-response',
  api_base_url: 'https://api.openai.com',
  api_key: 'sk-test',
  models: ['gpt-5-codex'],
  enabled: true,
};

function makeLlmConfig(provider: unknown = fakeProvider): ProviderConfigSource {
  return {
    getProvider: vi.fn(async () => provider),
    resolveTransformerChain: vi.fn(async () => ({
      providerTransformers: [],
      modelTransformers: [],
    })),
    getMainTransformer: vi.fn(async () => null),
  } as unknown as ProviderConfigSource;
}

// Helper: extract the value of a `-c key=value` override pair from the flat args.
function overrideValue(args: string[], key: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-c' && args[i + 1].startsWith(`${key}=`)) {
      return args[i + 1].slice(key.length + 1);
    }
  }
  return undefined;
}

describe('buildCodexConfigOverrides (the -c redirect contract)', () => {
  const overrides = buildCodexConfigOverrides('http://127.0.0.1:54321');
  const name = CODEX_PROXY_PROVIDER_NAME;

  it('selects the omnicross model_provider', () => {
    expect(overrideValue(overrides, 'model_provider')).toBe(`"${name}"`);
  });

  it('points base_url at the listener + configured base path', () => {
    expect(overrideValue(overrides, `model_providers.${name}.base_url`)).toBe(
      `"http://127.0.0.1:54321${CODEX_PROXY_BASE_PATH}"`
    );
  });

  it('selects the Responses-API wire', () => {
    expect(overrideValue(overrides, `model_providers.${name}.wire_api`)).toBe('"responses"');
  });

  it('sets requires_openai_auth as an UNQUOTED boolean (TOML-typed)', () => {
    // Must be the bare token `true`, not the string `"true"`.
    expect(overrideValue(overrides, `model_providers.${name}.requires_openai_auth`)).toBe('true');
  });

  it('disables server-side response storage (stateless upstream)', () => {
    expect(overrideValue(overrides, 'disable_response_storage')).toBe('true');
  });

  it('emits well-formed -c pairs (every -c is followed by a key=value)', () => {
    for (let i = 0; i < overrides.length; i += 2) {
      expect(overrides[i]).toBe('-c');
      expect(overrides[i + 1]).toMatch(/^[\w.]+=.+/);
    }
  });
});

describe('buildCodexLaunchConfig (BYO — registers a route on the resident proxy)', () => {
  // engine-provider-decouple task 2.9: the builder no longer boots a per-session
  // proxy — it registers a route on the resident ProviderProxy (the
  // single listener for the app session). Construct + start it here; reset after.
  beforeEach(async () => {
    __resetProviderProxyForTests();
    await getProviderProxy({ llmConfig: makeLlmConfig() }).start();
  });

  afterEach(async () => {
    await getProviderProxy().stop();
    __resetProviderProxyForTests();
  });

  it('registers a route and returns env + extraArgs embedding the resident port', async () => {
    const launch = await buildCodexLaunchConfig({
      llmConfig: makeLlmConfig(),
      providerId: 'openai-prov',
      model: 'gpt-5-codex',
      authMode: 'byo',
      sessionId: 'sess-1',
    });

    // baseUrl is the resident 127.0.0.1 listener.
    expect(launch.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // OPENAI_API_KEY is now the minted route TOKEN (the CLI forwards it; the
    // proxy looks it up + discards it, re-authing upstream).
    expect(launch.env.OPENAI_API_KEY).toMatch(/^[0-9a-f]{64}$/);

    // The base_url override embeds the resident listener + base path.
    const name = CODEX_PROXY_PROVIDER_NAME;
    expect(overrideValue(launch.extraArgs, `model_providers.${name}.base_url`)).toBe(
      `"${launch.baseUrl}${CODEX_PROXY_BASE_PATH}"`
    );

    // A route was registered on the resident proxy.
    expect(getProviderProxy().routeCount()).toBe(1);

    // The listener is actually up: a path matched by NO ingress parser 404s
    // (route guard) — with the token so it passes the route-token auth gate
    // first. NOTE: `/chat/completions` now HAS a parser (provider-proxy-
    // transformer-matrix), so probe an unhandled path (`/openai/embeddings`).
    const res = await fetch(`${launch.baseUrl}/openai/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${launch.env.OPENAI_API_KEY}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it('onSessionEnd removes the route (NOT the resident listener)', async () => {
    const launch = await buildCodexLaunchConfig({
      llmConfig: makeLlmConfig(),
      providerId: 'openai-prov',
      model: 'gpt-5-codex',
    });
    const { baseUrl } = launch;
    expect(getProviderProxy().routeCount()).toBe(1);

    launch.onSessionEnd();
    // The route is gone …
    expect(getProviderProxy().routeCount()).toBe(0);
    // … but the resident listener stays UP (only the route was dropped). The
    // now-stale token is rejected with 401 (no fallback — design D9).
    const after = await fetch(`${baseUrl}/openai/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${launch.env.OPENAI_API_KEY}` },
      body: '{}',
    });
    expect(after.status).toBe(401);
  });
});

describe('buildCodexLaunchConfig (error semantics — fail before registering a route)', () => {
  // The three "throws" cases fail BEFORE touching the resident proxy; the
  // subscription-boots case needs it. Construct + reset around all for safety.
  beforeEach(async () => {
    __resetProviderProxyForTests();
    await getProviderProxy({ llmConfig: makeLlmConfig() }).start();
  });

  afterEach(async () => {
    await getProviderProxy().stop();
    __resetProviderProxyForTests();
  });

  it('throws when the BYO provider is missing', async () => {
    await expect(
      buildCodexLaunchConfig({
        llmConfig: makeLlmConfig(null),
        providerId: 'missing-prov',
        model: 'gpt-5-codex',
        authMode: 'byo',
      })
    ).rejects.toThrow(/provider not found/i);
  });

  it('throws when the BYO provider has no API key', async () => {
    const noKey = { ...fakeProvider, api_key: '' };
    await expect(
      buildCodexLaunchConfig({
        llmConfig: makeLlmConfig(noKey),
        providerId: 'openai-prov',
        model: 'gpt-5-codex',
        authMode: 'byo',
      })
    ).rejects.toThrow(/no valid API key/i);
  });

  it('throws when subscription mode has no profile', async () => {
    await expect(
      buildCodexLaunchConfig({
        llmConfig: makeLlmConfig(),
        providerId: 'openai-prov',
        model: 'gpt-5-codex',
        authMode: 'subscription',
        subscriptionProfile: null,
      })
    ).rejects.toThrow(/subscription mode requires/i);
  });

  it('registers a route in subscription mode when a profile is supplied', async () => {
    const profile: SubscriptionAuthProfile = {
      authStrategy: {
        providerId: 'codex',
        applyHeaders: vi.fn(async () => {}),
        onUnauthorized: vi.fn(async () => false),
      } as unknown as SubscriptionAuthProfile['authStrategy'],
      resolveUpstreamUrl: () => 'https://chatgpt.com/backend-api/codex/responses',
    };
    const launch = await buildCodexLaunchConfig({
      llmConfig: makeLlmConfig(),
      providerId: 'codex',
      model: 'gpt-5-codex',
      authMode: 'subscription',
      subscriptionProfile: profile,
    });
    expect(launch.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(launch.env.OPENAI_API_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(getProviderProxy().routeCount()).toBe(1);
    launch.onSessionEnd();
    expect(getProviderProxy().routeCount()).toBe(0);
  });
});
