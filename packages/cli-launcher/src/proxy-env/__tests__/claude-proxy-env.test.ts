/**
 * Unit tests for the claude CLI launch-config builder (`claude-proxy-env.ts`).
 *
 * Mirrors `cli-proxy-env.test.ts`: the builder registers an anthropic-messages
 * route on the resident `ProviderProxy` and returns env + `onSessionEnd`.
 * Covers:
 *  (a) env contract (`ANTHROPIC_BASE_URL` root + `ANTHROPIC_AUTH_TOKEN` route
 *      token + NON-SECRET `ANTHROPIC_API_KEY` sentinel — the real key must NOT
 *      appear anywhere in the env);
 *  (b) targetProviderFormat narrowing (anthropic provider → 'anthropic',
 *      openai provider → 'transform') via the registered route;
 *  (c) `onSessionEnd` removes the route;
 *  (d) error semantics (missing provider / $ENV-empty key) fail BEFORE a route
 *      is registered.
 *
 * NOT E2E-verifiable here: no real claude binary. These tests prove the
 * builder CONTRACT (env + lifecycle); the daemon's launch boot-smoke proves
 * the wire round-trip.
 *
 * @module proxy-env/__tests__/claude-proxy-env.test
 */

import type { ProviderConfigSource } from '@omnicross/core';
import {
  __resetProviderProxyForTests,
  getProviderProxy,
} from '@omnicross/core/provider-proxy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildClaudeCliLaunchConfig,
  CLAUDE_PROXY_API_KEY_SENTINEL,
} from '../claude-proxy-env';

const anthropicProvider = {
  id: 'anthropic-prov',
  name: 'Anthropic',
  apiFormat: 'anthropic',
  api_base_url: 'https://api.anthropic.com',
  api_key: 'sk-ant-real-secret',
  models: ['claude-sonnet-4-6'],
  enabled: true,
};

const openaiProvider = {
  ...anthropicProvider,
  id: 'openai-prov',
  apiFormat: 'openai',
  api_base_url: 'https://api.openai.com/v1',
  api_key: 'sk-openai-real-secret',
};

function makeLlmConfig(provider: unknown): ProviderConfigSource {
  return {
    getProvider: vi.fn(async (id: string) =>
      provider && (provider as { id: string }).id === id ? provider : null,
    ),
    resolveTransformerChain: vi.fn(async () => ({
      providerTransformers: [],
      modelTransformers: [],
    })),
    getMainTransformer: vi.fn(async () => null),
  } as unknown as ProviderConfigSource;
}

const TOKEN_RE = /^[0-9a-f]{64}$/;

describe('buildClaudeCliLaunchConfig (anthropic-messages route on the resident proxy)', () => {
  beforeEach(async () => {
    __resetProviderProxyForTests();
    await getProviderProxy({ llmConfig: makeLlmConfig(anthropicProvider) }).start();
  });

  afterEach(async () => {
    await getProviderProxy().stop();
    __resetProviderProxyForTests();
  });

  it('env contract: BASE_URL root + AUTH_TOKEN route token + non-secret API_KEY sentinel', async () => {
    const launch = await buildClaudeCliLaunchConfig({
      llmConfig: makeLlmConfig(anthropicProvider),
      providerId: 'anthropic-prov',
      model: 'claude-sonnet-4-6',
      sessionId: 'launch:claude',
    });
    // Base is the listener ROOT (the CLI appends /v1/messages itself).
    expect(launch.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(launch.env.ANTHROPIC_BASE_URL).toBe(launch.baseUrl);
    // Route token rides Authorization: Bearer via ANTHROPIC_AUTH_TOKEN.
    expect(launch.env.ANTHROPIC_AUTH_TOKEN).toMatch(TOKEN_RE);
    // API key slot is the non-secret prompt-suppression sentinel.
    expect(launch.env.ANTHROPIC_API_KEY).toBe(CLAUDE_PROXY_API_KEY_SENTINEL);
    expect(launch.env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6');
    // The REAL upstream key never enters the CLI env.
    expect(JSON.stringify(launch.env)).not.toContain('sk-ant-real-secret');
    expect(getProviderProxy().routeCount()).toBe(1);
    launch.onSessionEnd();
    expect(getProviderProxy().routeCount()).toBe(0);
  });

  it('targetProviderFormat: anthropic provider → same-format, openai provider → transform', async () => {
    const a = await buildClaudeCliLaunchConfig({
      llmConfig: makeLlmConfig(anthropicProvider),
      providerId: 'anthropic-prov',
      model: 'm',
    });
    const routes = getProviderProxy().getRouteMap();
    expect(routes.lookup(a.env.ANTHROPIC_AUTH_TOKEN)?.targetProviderFormat).toBe('anthropic');
    a.onSessionEnd();

    const b = await buildClaudeCliLaunchConfig({
      llmConfig: makeLlmConfig(openaiProvider),
      providerId: 'openai-prov',
      model: 'm',
    });
    expect(routes.lookup(b.env.ANTHROPIC_AUTH_TOKEN)?.targetProviderFormat).toBe('transform');
    b.onSessionEnd();
  });

  it('missing provider → throws BEFORE registering a route', async () => {
    await expect(
      buildClaudeCliLaunchConfig({
        llmConfig: makeLlmConfig(null),
        providerId: 'nope',
        model: 'm',
      }),
    ).rejects.toThrow(/provider not found: nope/);
    expect(getProviderProxy().routeCount()).toBe(0);
  });

  it('$ENV-empty key → throws BEFORE registering a route', async () => {
    const keyless = { ...anthropicProvider, api_key: '$OMNICROSS_TEST_UNSET_VAR' };
    delete process.env['OMNICROSS_TEST_UNSET_VAR'];
    await expect(
      buildClaudeCliLaunchConfig({
        llmConfig: makeLlmConfig(keyless),
        providerId: 'anthropic-prov',
        model: 'm',
      }),
    ).rejects.toThrow(/no valid API key/);
    expect(getProviderProxy().routeCount()).toBe(0);
  });
});
