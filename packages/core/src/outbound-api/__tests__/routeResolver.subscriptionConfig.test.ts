/**
 * routeResolver seam tests (D-SEAM) — the opaque `route.subscriptionConfig`.
 *
 * Proves the route resolver reads the per-account OpenCodeGo config from the
 * injected registry's OPTIONAL `getOpenCodeGoConfig()` getter and stamps it onto
 * `route.subscriptionConfig` for the opencodego provider ONLY — leaving it
 * `undefined` for non-opencodego routes and tolerating a registry that does not
 * implement the getter. Core holds the value as `unknown`; these tests never
 * import `@omnicross/subscriptions` (the cross-layer litmus stays 0).
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

// A BYO config source whose `getProvider` always returns null → the resolver
// takes the subscription branch for a subscription-classified id.
const NO_BYO_LLM_CONFIG = {
  getProvider: async () => null,
} as unknown as ProviderConfigSource;

/** A minimal opencodego-ish dispatch profile (only what the resolver touches). */
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

function messagesConfig(defaultModel: string): EndpointRoutingConfig {
  return {
    endpoint: 'messages',
    defaultModel,
    backgroundModel: defaultModel,
    useSubscription: true,
  };
}

afterEach(() => {
  setSubscriptionRegistryForOutbound(null);
});

describe('routeResolver — opaque subscriptionConfig seam', () => {
  it('opencodego route → route.subscriptionConfig is populated from the registry getter', async () => {
    const opaqueConfig = { baseUrl: 'https://host.example', modelMap: { default: { modelId: 'x' } } };
    const registry: SubscriptionRegistryLike = {
      getProfile: (id) => (id === 'opencodego' ? fakeProfile('opencodego') : null),
      getOpenCodeGoConfig: async () => opaqueConfig,
    };
    setSubscriptionRegistryForOutbound(registry);

    const result = await resolveRoute({
      config: messagesConfig('opencodego,minimax-m2.5'),
      role: 'default',
      ingressFormat: 'anthropic-messages',
      llmConfig: NO_BYO_LLM_CONFIG,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.subscriptionConfig).toBe(opaqueConfig);
  });

  it('non-opencodego subscription route → route.subscriptionConfig is undefined', async () => {
    const registry: SubscriptionRegistryLike = {
      getProfile: (id) => (id === 'claude' ? fakeProfile('claude') : null),
      // Even though the getter EXISTS, it must not be read for claude.
      getOpenCodeGoConfig: async () => ({ baseUrl: 'should-not-be-read' }),
    };
    setSubscriptionRegistryForOutbound(registry);

    const result = await resolveRoute({
      config: messagesConfig('claude,claude-sonnet-4-5'),
      role: 'default',
      ingressFormat: 'anthropic-messages',
      llmConfig: NO_BYO_LLM_CONFIG,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.subscriptionConfig).toBeUndefined();
  });

  it('registry WITHOUT getOpenCodeGoConfig → no throw, subscriptionConfig undefined', async () => {
    const registry: SubscriptionRegistryLike = {
      // Narrow fake — only `getProfile`, no optional config getter.
      getProfile: (id) => (id === 'opencodego' ? fakeProfile('opencodego') : null),
    };
    setSubscriptionRegistryForOutbound(registry);

    const result = await resolveRoute({
      config: messagesConfig('opencodego,minimax-m2.5'),
      role: 'default',
      ingressFormat: 'anthropic-messages',
      llmConfig: NO_BYO_LLM_CONFIG,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.subscriptionConfig).toBeUndefined();
  });
});
