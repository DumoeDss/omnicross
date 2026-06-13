/**
 * Unit tests for the chat-completions CLI launch-config builder
 * (`cli-proxy-env.ts`).
 *
 * The builder registers a route on the resident `ProviderProxy` and returns the
 * per-backend `env` + `onSessionEnd`. Covers:
 *  (a) qwen / copilot env keys (exact research contract) + the route token;
 *  (b) opencode config-file injection (`OPENCODE_CONFIG` + `{env:…}` token);
 *  (c) `onSessionEnd` removes the route (resident listener stays up);
 *  (d) error semantics (missing provider / key) fail before registering a route.
 *
 * NOT E2E-verifiable here: there is no real qwen/copilot/opencode binary in this
 * environment. These tests prove the builder CONTRACT (env/config + lifecycle).
 *
 * @module proxy-env/__tests__/cli-proxy-env.test
 */

import { readFileSync } from 'node:fs';

import type { ProviderConfigSource } from '@omnicross/core';
import {
  __resetProviderProxyForTests,
  getProviderProxy,
} from '@omnicross/core/provider-proxy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildChatCliLaunchConfig,
  buildGeminiCliLaunchConfig,
  CHAT_PROXY_BASE_PATH,
  OPENCODE_PROXY_TOKEN_ENV,
} from '../cli-proxy-env';

const fakeProvider = {
  id: 'openai-prov',
  name: 'OpenAI',
  apiFormat: 'openai',
  api_base_url: 'https://api.openai.com',
  api_key: 'sk-test',
  models: ['gpt-5'],
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

const TOKEN_RE = /^[0-9a-f]{64}$/;

describe('buildChatCliLaunchConfig (registers a route on the resident proxy)', () => {
  beforeEach(async () => {
    __resetProviderProxyForTests();
    await getProviderProxy({ llmConfig: makeLlmConfig() }).start();
  });

  afterEach(async () => {
    await getProviderProxy().stop();
    __resetProviderProxyForTests();
  });

  it('qwen → OPENAI_BASE_URL/_API_KEY/_MODEL + base path + token', async () => {
    const launch = await buildChatCliLaunchConfig({
      backendId: 'qwen',
      llmConfig: makeLlmConfig(),
      providerId: 'openai-prov',
      model: 'gpt-5',
      sessionId: 'sess-1',
    });
    expect(launch.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(launch.env.OPENAI_BASE_URL).toBe(`${launch.baseUrl}${CHAT_PROXY_BASE_PATH}`);
    expect(launch.env.OPENAI_API_KEY).toMatch(TOKEN_RE);
    expect(launch.env.OPENAI_MODEL).toBe('gpt-5');
    expect(getProviderProxy().routeCount()).toBe(1);
    launch.onSessionEnd();
    expect(getProviderProxy().routeCount()).toBe(0);
  });

  it('copilot → COPILOT_PROVIDER_* keys (type=openai) + COPILOT_MODEL + token', async () => {
    const launch = await buildChatCliLaunchConfig({
      backendId: 'copilot',
      llmConfig: makeLlmConfig(),
      providerId: 'openai-prov',
      model: 'gpt-5',
    });
    expect(launch.env.COPILOT_PROVIDER_BASE_URL).toBe(`${launch.baseUrl}${CHAT_PROXY_BASE_PATH}`);
    expect(launch.env.COPILOT_PROVIDER_TYPE).toBe('openai');
    expect(launch.env.COPILOT_PROVIDER_API_KEY).toMatch(TOKEN_RE);
    expect(launch.env.COPILOT_MODEL).toBe('gpt-5');
    launch.onSessionEnd();
  });

  it('opencode → OPENCODE_CONFIG file (openai-compatible adapter) + token env', async () => {
    const launch = await buildChatCliLaunchConfig({
      backendId: 'opencode',
      llmConfig: makeLlmConfig(),
      providerId: 'openai-prov',
      model: 'gpt-5',
    });
    // No base-url env redirect — the redirect lives in the config FILE.
    expect(launch.env.OPENAI_BASE_URL).toBeUndefined();
    expect(launch.env.OPENCODE_CONFIG).toBeTruthy();
    // The token rides its own env var, referenced by `{env:…}` in the file.
    expect(launch.env[OPENCODE_PROXY_TOKEN_ENV]).toMatch(TOKEN_RE);

    const written = JSON.parse(readFileSync(launch.env.OPENCODE_CONFIG, 'utf-8')) as {
      provider: Record<string, { npm: string; options: { baseURL: string; apiKey: string } }>;
    };
    const prov = written.provider.omnicross;
    expect(prov.npm).toBe('@ai-sdk/openai-compatible');
    expect(prov.options.baseURL).toBe(`${launch.baseUrl}${CHAT_PROXY_BASE_PATH}`);
    // The secret is NOT inlined — it is an env reference.
    expect(prov.options.apiKey).toBe(`{env:${OPENCODE_PROXY_TOKEN_ENV}}`);

    launch.onSessionEnd();
    expect(getProviderProxy().routeCount()).toBe(0);
  });

  it('onSessionEnd removes the route; the now-stale token is rejected 401', async () => {
    const launch = await buildChatCliLaunchConfig({
      backendId: 'qwen',
      llmConfig: makeLlmConfig(),
      providerId: 'openai-prov',
      model: 'gpt-5',
    });
    const { baseUrl } = launch;
    expect(getProviderProxy().routeCount()).toBe(1);
    launch.onSessionEnd();
    expect(getProviderProxy().routeCount()).toBe(0);
    const after = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${launch.env.OPENAI_API_KEY}` },
      body: '{}',
    });
    expect(after.status).toBe(401);
  });
});

describe('buildGeminiCliLaunchConfig (gemini-CLI forced API-key, Gemini ingress)', () => {
  beforeEach(async () => {
    __resetProviderProxyForTests();
    await getProviderProxy({ llmConfig: makeLlmConfig() }).start();
  });
  afterEach(async () => {
    await getProviderProxy().stop();
    __resetProviderProxyForTests();
  });

  it('sets GOOGLE_GEMINI_BASE_URL (listener ROOT, no /v1) + GEMINI_API_KEY token + model', async () => {
    const launch = await buildGeminiCliLaunchConfig({
      llmConfig: makeLlmConfig(),
      providerId: 'openai-prov',
      model: 'gemini-2.5-pro',
      sessionId: 'sess-g',
    });
    expect(launch.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // base is the LISTENER ROOT — the gemini-CLI appends `/v1beta/models/<m>:...`.
    expect(launch.env.GOOGLE_GEMINI_BASE_URL).toBe(launch.baseUrl);
    expect(launch.env.GOOGLE_GEMINI_BASE_URL).not.toContain(CHAT_PROXY_BASE_PATH);
    // Route token rides GEMINI_API_KEY (forwarded as x-goog-api-key by the CLI).
    expect(launch.env.GEMINI_API_KEY).toMatch(TOKEN_RE);
    expect(launch.env.GEMINI_MODEL).toBe('gemini-2.5-pro');
    expect(getProviderProxy().routeCount()).toBe(1);
    launch.onSessionEnd();
    expect(getProviderProxy().routeCount()).toBe(0);
  });

  it('forces API-key mode off the OAuth/Code-Assist path (GOOGLE_GENAI_USE_GCA=false; no GOOGLE_API_KEY)', async () => {
    const launch = await buildGeminiCliLaunchConfig({
      llmConfig: makeLlmConfig(),
      providerId: 'openai-prov',
      model: 'gemini-2.5-pro',
    });
    // GEMINI_API_KEY presence selects USE_GEMINI; GCA flag is explicitly disabled.
    expect(launch.env.GEMINI_API_KEY).toBeTruthy();
    expect(launch.env.GOOGLE_GENAI_USE_GCA).toBe('false');
    // Never steer onto the Vertex egress.
    expect(launch.env.GOOGLE_API_KEY).toBeUndefined();
    expect(launch.env.GOOGLE_GENAI_USE_VERTEXAI).toBeUndefined();
    expect(launch.env.GOOGLE_CLOUD_PROJECT).toBeUndefined();
    launch.onSessionEnd();
  });

  it('onSessionEnd removes the route; the now-stale token is rejected 401 (x-goog-api-key)', async () => {
    const launch = await buildGeminiCliLaunchConfig({
      llmConfig: makeLlmConfig(),
      providerId: 'openai-prov',
      model: 'gemini-2.5-pro',
    });
    const { baseUrl } = launch;
    expect(getProviderProxy().routeCount()).toBe(1);
    launch.onSessionEnd();
    expect(getProviderProxy().routeCount()).toBe(0);
    const after = await fetch(`${baseUrl}/v1beta/models/gemini-2.5-pro:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': launch.env.GEMINI_API_KEY },
      body: '{}',
    });
    expect(after.status).toBe(401);
  });

  it('throws when the provider is missing (no route registered)', async () => {
    await expect(
      buildGeminiCliLaunchConfig({
        llmConfig: makeLlmConfig(null),
        providerId: 'missing',
        model: 'gemini-2.5-pro',
      }),
    ).rejects.toThrow(/provider not found/i);
    expect(getProviderProxy().routeCount()).toBe(0);
  });
});

describe('buildChatCliLaunchConfig (error semantics — fail before registering a route)', () => {
  beforeEach(async () => {
    __resetProviderProxyForTests();
    await getProviderProxy({ llmConfig: makeLlmConfig() }).start();
  });
  afterEach(async () => {
    await getProviderProxy().stop();
    __resetProviderProxyForTests();
  });

  it('throws when the provider is missing (no route registered)', async () => {
    await expect(
      buildChatCliLaunchConfig({
        backendId: 'qwen',
        llmConfig: makeLlmConfig(null),
        providerId: 'missing',
        model: 'gpt-5',
      }),
    ).rejects.toThrow(/provider not found/i);
    expect(getProviderProxy().routeCount()).toBe(0);
  });

  it('throws when the provider has no API key', async () => {
    const noKey = { ...fakeProvider, api_key: '' };
    await expect(
      buildChatCliLaunchConfig({
        backendId: 'copilot',
        llmConfig: makeLlmConfig(noKey),
        providerId: 'openai-prov',
        model: 'gpt-5',
      }),
    ).rejects.toThrow(/no valid API key/i);
    expect(getProviderProxy().routeCount()).toBe(0);
  });
});
