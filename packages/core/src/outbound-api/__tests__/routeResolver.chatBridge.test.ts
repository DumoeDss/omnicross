/**
 * routeResolver tests for the OpenAI-chat bridge (openai-chat-bridge #11).
 *
 * Two additions this change makes to the `chat` endpoint's resolution:
 *  1. PREFIX dispatch (design D2): `dispatchMode: 'prefix'` routes by the
 *     requested model's name prefix to `prefixTargets`; an unmatched prefix →
 *     clear 404. The DEFAULT (`dispatchMode` absent / `'list'`) stays byte-
 *     identical to the pre-change list-mapped resolution (zero regression).
 *  2. SUBSCRIPTION gate (design D1): the `chat` endpoint now passes the
 *     `endpointSupportsSubscription` gate, so a subscription-classified provider
 *     resolves to a subscription route carrying the top-level
 *     `route.subscriptionProfile` (which the chat ingress reads).
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { ProviderConfigSource } from '../../ports/provider-config-source';
import type { SubscriptionDispatchProfile } from '../../provider-proxy/types';
import { resolveRoute } from '../routeResolver';
import {
  setSubscriptionRegistryForOutbound,
  type SubscriptionRegistryLike,
} from '../subscriptionRegistryPort';
import type { EndpointRoutingConfig } from '../types';

// A BYO config source that returns a provider row for every id (prefix-dispatch
// targets resolve to BYO routes in these tests).
const BYO_LLM_CONFIG = {
  getProvider: async (id: string) => ({
    id,
    name: id,
    api_key: 'sk-x',
    api_base_url: 'https://upstream.example',
    models: ['m'],
    enabled: true,
  }),
} as unknown as ProviderConfigSource;

// A config source whose `getProvider` always returns null → a subscription-
// classified id takes the subscription branch.
const NO_BYO_LLM_CONFIG = {
  getProvider: async () => null,
} as unknown as ProviderConfigSource;

function fakeClaudeProfile(): SubscriptionDispatchProfile {
  return {
    providerId: 'claude',
    displayName: 'Claude',
    authStrategy: { providerId: 'claude' } as SubscriptionDispatchProfile['authStrategy'],
    mode: 'pass-through',
    resolveUpstreamUrl: () => 'https://api.anthropic.com/v1/messages',
    providerTransformerNames: ['anthropic'],
    modelTransformerNames: [],
  };
}

afterEach(() => {
  setSubscriptionRegistryForOutbound(null);
});

describe('resolveRoute — chat PREFIX dispatch', () => {
  const prefixConfig: EndpointRoutingConfig = {
    endpoint: 'chat',
    models: [],
    useSubscription: false,
    dispatchMode: 'prefix',
    prefixTargets: {
      claude: 'panthropic,claude-sonnet-4-5',
      gpt: 'popenai,gpt-4o',
    },
  };

  it('claude-* model → the configured claude target', async () => {
    const result = await resolveRoute({
      config: prefixConfig,
      ingressFormat: 'openai-chat',
      llmConfig: BYO_LLM_CONFIG,
      requestedModel: 'claude-opus-4-8-2026xxxx',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.providerId).toBe('panthropic');
    expect(result.route.model).toBe('claude-sonnet-4-5');
  });

  it('gpt-* model → the configured gpt target', async () => {
    const result = await resolveRoute({
      config: prefixConfig,
      ingressFormat: 'openai-chat',
      llmConfig: BYO_LLM_CONFIG,
      requestedModel: 'gpt-5-codex',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.providerId).toBe('popenai');
    expect(result.route.model).toBe('gpt-4o');
  });

  it('matched prefix with NO configured target → 404 unroutable', async () => {
    // gemini classifies but is not in prefixTargets.
    const result = await resolveRoute({
      config: prefixConfig,
      ingressFormat: 'openai-chat',
      llmConfig: BYO_LLM_CONFIG,
      requestedModel: 'gemini-2.5-pro',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(404);
    expect(result.error.message).toContain('prefix target');
  });

  it('unknown prefix → 404 unroutable', async () => {
    const result = await resolveRoute({
      config: prefixConfig,
      ingressFormat: 'openai-chat',
      llmConfig: BYO_LLM_CONFIG,
      requestedModel: 'deepseek-v3',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(404);
  });
});

describe('resolveRoute — chat LIST dispatch is byte-identical (zero regression)', () => {
  const listConfig: EndpointRoutingConfig = {
    endpoint: 'chat',
    models: ['pa,gpt-4o', 'pb,glm-4.7'],
    useSubscription: false,
    // dispatchMode absent ⇒ default 'list'.
  };

  it('resolves by list exactly as before when dispatchMode is absent', async () => {
    const result = await resolveRoute({
      config: listConfig,
      ingressFormat: 'openai-chat',
      llmConfig: BYO_LLM_CONFIG,
      requestedModel: 'glm-4.7',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.providerId).toBe('pb');
    expect(result.route.model).toBe('glm-4.7');
  });

  it('explicit dispatchMode: "list" behaves the same as absent', async () => {
    const result = await resolveRoute({
      config: { ...listConfig, dispatchMode: 'list' },
      ingressFormat: 'openai-chat',
      llmConfig: BYO_LLM_CONFIG,
      requestedModel: 'unknown-model',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(404);
    expect(result.error.message).toContain('GET /v1/models');
  });
});

describe('resolveRoute — chat SUBSCRIPTION gate now open', () => {
  it('claude subscription over chat → subscription route with top-level profile', async () => {
    setSubscriptionRegistryForOutbound({
      getProfile: (id) => (id === 'claude' ? fakeClaudeProfile() : null),
    } as SubscriptionRegistryLike);

    const result = await resolveRoute({
      config: {
        endpoint: 'chat',
        models: ['claude,claude-sonnet-4-5'],
        useSubscription: true,
      },
      ingressFormat: 'openai-chat',
      llmConfig: NO_BYO_LLM_CONFIG,
      requestedModel: 'claude-sonnet-4-5',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.authMode).toBe('subscription');
    expect(result.route.providerId).toBe('claude');
    // The chat ingress reads the TOP-LEVEL subscriptionProfile (like Responses).
    expect(result.route.subscriptionProfile).not.toBeNull();
    expect(result.route.subscriptionProfile).toBeDefined();
  });

  it('PREFIX dispatch whose claude target is a SUBSCRIPTION ref → subscription route', async () => {
    // The seam between the two new features: a prefix-resolved ref that points at
    // a subscription-classified provider must flow into the subscription gate.
    setSubscriptionRegistryForOutbound({
      getProfile: (id) => (id === 'claude' ? fakeClaudeProfile() : null),
    } as SubscriptionRegistryLike);

    const result = await resolveRoute({
      config: {
        endpoint: 'chat',
        models: [],
        useSubscription: true,
        dispatchMode: 'prefix',
        // The claude prefix target is a SUBSCRIPTION ref (no BYO row backs it).
        prefixTargets: { claude: 'claude,claude-sonnet-4-5' },
      },
      ingressFormat: 'openai-chat',
      llmConfig: NO_BYO_LLM_CONFIG,
      requestedModel: 'claude-sonnet-4-5',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Prefix classified claude-* → the subscription ref → the subscription branch.
    expect(result.route.authMode).toBe('subscription');
    expect(result.route.providerId).toBe('claude');
    expect(result.route.model).toBe('claude-sonnet-4-5');
    // The chat ingress reads the top-level subscriptionProfile.
    expect(result.route.subscriptionProfile).toBeDefined();
    expect(result.route.subscriptionProfile).not.toBeNull();
  });

  it('subscription disabled on chat → 503 (gate 1)', async () => {
    setSubscriptionRegistryForOutbound({
      getProfile: (id) => (id === 'claude' ? fakeClaudeProfile() : null),
    } as SubscriptionRegistryLike);

    const result = await resolveRoute({
      config: {
        endpoint: 'chat',
        models: ['claude,claude-sonnet-4-5'],
        useSubscription: false,
      },
      ingressFormat: 'openai-chat',
      llmConfig: NO_BYO_LLM_CONFIG,
      requestedModel: 'claude-sonnet-4-5',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(503);
    expect(result.error.message).toContain('disabled');
  });
});
