/**
 * routeResolver apiKeyId-attribution tests (omnicross-udash-attrib, D5). The
 * outbound `resolveRoute` stamps the verified named-key id onto EVERY route
 * (BYO + subscription, all endpoints) both as the top-level `route.apiKeyId` AND
 * inside `anthropicSdkHints.attribution.apiKeyId`. Omitting `apiKeyId` leaves the
 * route's field `undefined` (so the resident-proxy path records `apiKeyId: null`).
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

// A BYO config source that returns a provider row for every id.
const llmConfig = {
  getProvider: async (id: string) => ({
    id,
    name: id,
    api_key: 'sk-x',
    api_base_url: 'https://upstream.example',
    models: ['m'],
    enabled: true,
  }),
} as unknown as ProviderConfigSource;

// A BYO config source whose `getProvider` returns null → subscription branch.
const NO_BYO_LLM_CONFIG = {
  getProvider: async () => null,
} as unknown as ProviderConfigSource;

function messages(map: Record<string, string>): EndpointRoutingConfig {
  return { endpoint: 'messages', modelMap: map, useSubscription: true };
}
const MSG_MAP = { fable: 'pf,mf', opus: 'po,mo', sonnet: 'ps,ms', haiku: 'ph,mh' };

function fakeProfile(providerId: string): SubscriptionDispatchProfile {
  return {
    providerId: providerId as SubscriptionDispatchProfile['providerId'],
    displayName: providerId,
    authStrategy: { providerId } as SubscriptionDispatchProfile['authStrategy'],
    mode: 'transformer',
    resolveUpstreamUrl: () => 'https://upstream.example/v1/messages',
    providerTransformerNames: [],
    modelTransformerNames: [],
  };
}

afterEach(() => {
  setSubscriptionRegistryForOutbound(null);
});

describe('resolveRoute — apiKeyId attribution', () => {
  it('BYO route stamps apiKeyId on the route AND the anthropic hints', async () => {
    const result = await resolveRoute({
      config: messages(MSG_MAP),
      ingressFormat: 'anthropic-messages',
      llmConfig,
      requestedModel: 'claude-opus-4-8',
      apiKeyId: 'key-123',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.apiKeyId).toBe('key-123');
    expect(result.route.anthropicSdkHints?.attribution?.apiKeyId).toBe('key-123');
  });

  it('BYO route without apiKeyId → route.apiKeyId undefined, hints attribution null', async () => {
    const result = await resolveRoute({
      config: messages(MSG_MAP),
      ingressFormat: 'anthropic-messages',
      llmConfig,
      requestedModel: 'claude-opus-4-8',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.apiKeyId).toBeUndefined();
    expect(result.route.anthropicSdkHints?.attribution?.apiKeyId).toBeNull();
  });

  it('subscription route stamps apiKeyId on the route AND the hints', async () => {
    const registry: SubscriptionRegistryLike = {
      getProfile: (id) => (id === 'claude' ? fakeProfile('claude') : null),
    };
    setSubscriptionRegistryForOutbound(registry);

    const result = await resolveRoute({
      config: messages({ fable: 'claude,c', opus: 'claude,c', sonnet: 'claude,c', haiku: 'claude,c' }),
      role: 'default',
      ingressFormat: 'anthropic-messages',
      llmConfig: NO_BYO_LLM_CONFIG,
      apiKeyId: 'key-sub',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.authMode).toBe('subscription');
    expect(result.route.apiKeyId).toBe('key-sub');
    expect(result.route.anthropicSdkHints?.attribution?.apiKeyId).toBe('key-sub');
  });

  it('subscription route without apiKeyId → route.apiKeyId undefined, hints attribution null', async () => {
    const registry: SubscriptionRegistryLike = {
      getProfile: (id) => (id === 'claude' ? fakeProfile('claude') : null),
    };
    setSubscriptionRegistryForOutbound(registry);

    const result = await resolveRoute({
      config: messages({ fable: 'claude,c', opus: 'claude,c', sonnet: 'claude,c', haiku: 'claude,c' }),
      role: 'default',
      ingressFormat: 'anthropic-messages',
      llmConfig: NO_BYO_LLM_CONFIG,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.apiKeyId).toBeUndefined();
    expect(result.route.anthropicSdkHints?.attribution?.apiKeyId).toBeNull();
  });
});
