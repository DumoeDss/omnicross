import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConfigSource } from '../../ports/provider-config-source';
import {
  setSubscriptionRegistryForOutbound,
  type SubscriptionRegistryLike,
} from '../../outbound-api/subscriptionRegistryPort';
import type { SubscriptionDispatchProfile } from '../types';
import { RouteLeaseTargetResolver } from '../RouteLeaseTargetResolver';
import {
  parseRouteLeaseCreate,
  ROUTE_LEASE_REQUEST_SCHEMA,
  type NormalizedRouteLeaseRequest,
  type RouteLeaseUpstream,
} from '../routeLeaseSchema';

interface ProviderShape {
  id: string;
  name: string;
  apiFormat: 'openai' | 'anthropic' | 'openai-response';
  api_base_url: string;
  api_key: string;
  models: string[];
  enabled?: boolean;
}

function provider(overrides: Partial<ProviderShape> = {}): ProviderShape {
  return {
    id: 'provider-a',
    name: 'Provider A',
    apiFormat: 'openai-response',
    api_base_url: 'http://127.0.0.1:9',
    api_key: 'sk-local-canary',
    models: ['model-a'],
    ...overrides,
  };
}

function configSource(
  providers: ProviderShape[],
  options: { transformerNames?: string[]; registeredTransformers?: string[] } = {},
): ProviderConfigSource {
  const registered = new Set(options.registeredTransformers ?? options.transformerNames ?? []);
  return {
    getProvider: vi.fn(async (id: string) => providers.find((entry) => entry.id === id) ?? null),
    resolveTransformerChain: vi.fn(async () => ({
      providerTransformers: (options.transformerNames ?? []).map((name) => ({ name })),
      modelTransformers: [],
    })),
    getMainTransformer: vi.fn(async () => null),
    getTransformerService: vi.fn(() => ({
      getTransformer: (name: string) => registered.has(name) ? { name } : undefined,
    })),
  } as unknown as ProviderConfigSource;
}

function request(
  upstream: RouteLeaseUpstream,
  overrides: Record<string, unknown> = {},
): NormalizedRouteLeaseRequest {
  return parseRouteLeaseCreate({
    schemaVersion: ROUTE_LEASE_REQUEST_SCHEMA,
    consumer: 'rasen',
    runtime: 'codex',
    upstream,
    model: 'model-a',
    ttlSeconds: 60,
    ...overrides,
  }, 'resolver-test-key').request;
}

function subscriptionProfile(
  overrides: Partial<SubscriptionDispatchProfile> = {},
): SubscriptionDispatchProfile {
  return {
    providerId: 'claude',
    displayName: 'Claude subscription',
    mode: 'pass-through',
    authStrategy: {
      kind: 'oauth-bearer',
      providerId: 'claude',
      applyHeaders: async () => {},
      onUnauthorized: async () => false,
      describeStatus: async () => ({ providerId: 'claude', status: 'configured' }),
    },
    ...overrides,
  };
}

afterEach(() => setSubscriptionRegistryForOutbound(null));

describe('RouteLeaseTargetResolver provider preflight', () => {
  it('freezes an explicit provider key with strict fallback and never consults another provider', async () => {
    const source = configSource([
      provider(),
      provider({ id: 'global-default', name: 'Must not be read' }),
    ]);
    const providerKeys = {
      hasUsableKey: vi.fn(async () => true),
      hasUsableKeys: vi.fn(async () => true),
    };
    const resolver = new RouteLeaseTargetResolver(source, { providerKeys });

    const route = await resolver.resolve(request({
      kind: 'provider',
      providerId: 'provider-a',
      keyId: 'key-a',
    }));

    expect(route).toMatchObject({
      providerId: 'provider-a',
      model: 'model-a',
      ingressFormat: 'openai-responses',
      preferredKeyId: 'key-a',
      boundKeyFallbackPolicy: 'strict',
    });
    expect(route.requestedModel).toBeUndefined();
    expect(providerKeys.hasUsableKey).toHaveBeenCalledWith('provider-a', 'key-a');
    expect(source.getProvider).toHaveBeenCalledTimes(2);
    expect(source.getProvider).toHaveBeenNthCalledWith(1, 'provider-a');
    expect(source.getProvider).toHaveBeenNthCalledWith(2, 'provider-a');
  });

  it.each([
    ['missing provider', [], { kind: 'provider', providerId: 'missing' }, 'upstream_not_found'],
    ['disabled provider', [provider({ enabled: false })], { kind: 'provider', providerId: 'provider-a' }, 'upstream_unavailable'],
    ['unconfigured model', [provider({ models: ['other-model'] })], { kind: 'provider', providerId: 'provider-a' }, 'model_not_configured'],
  ] as const)('rejects %s before route resolution', async (_name, providers, upstream, code) => {
    const resolver = new RouteLeaseTargetResolver(configSource([...providers]), {
      providerKeys: { hasUsableKey: async () => true, hasUsableKeys: async () => true },
    });
    await expect(resolver.resolve(request(upstream))).rejects.toMatchObject({ code });
  });

  it('rejects an unavailable strict key and a provider with no direct or pooled credential', async () => {
    const source = configSource([provider({ api_key: '' })]);
    const resolver = new RouteLeaseTargetResolver(source, {
      providerKeys: {
        hasUsableKey: async () => false,
        hasUsableKeys: async () => false,
        getKeyAvailability: async (_providerId, keyId) => keyId === 'missing-key' ? 'not-found' : 'unavailable',
      },
    });
    await expect(resolver.resolve(request({
      kind: 'provider', providerId: 'provider-a', keyId: 'missing-key',
    }))).rejects.toMatchObject({ code: 'upstream_not_found' });
    await expect(resolver.resolve(request({
      kind: 'provider', providerId: 'provider-a', keyId: 'disabled-key',
    }))).rejects.toMatchObject({ code: 'upstream_unavailable' });
    await expect(resolver.resolve(request({
      kind: 'provider', providerId: 'provider-a',
    }))).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });

  it('preserves exhausted pool retry horizon as upstream_exhausted', async () => {
    const resolver = new RouteLeaseTargetResolver(configSource([provider({ api_key: '' })]), {
      providerKeys: {
        hasUsableKey: async () => false,
        hasUsableKeys: async () => false,
        getPoolAvailability: async () => ({ outcome: 'exhausted', retryAfterSeconds: 73 }),
      },
    });

    await expect(resolver.resolve(request({
      kind: 'provider', providerId: 'provider-a',
    }))).rejects.toMatchObject({
      code: 'upstream_exhausted',
      status: 429,
      retryAfterSeconds: 73,
    });
  });

  it('requires the serving transformer chain for a cross-format provider', async () => {
    const crossFormat = provider({ apiFormat: 'openai' });
    const unsupported = new RouteLeaseTargetResolver(configSource([crossFormat]), {
      providerKeys: { hasUsableKey: async () => true, hasUsableKeys: async () => true },
    });
    await expect(unsupported.resolve(request(
      { kind: 'provider', providerId: 'provider-a' },
      { runtime: 'claude' },
    ))).rejects.toMatchObject({ code: 'format_unsupported' });

    const supported = new RouteLeaseTargetResolver(configSource([crossFormat], {
      transformerNames: ['openai'],
    }), {
      providerKeys: { hasUsableKey: async () => true, hasUsableKeys: async () => true },
    });
    await expect(supported.resolve(request(
      { kind: 'provider', providerId: 'provider-a' },
      { runtime: 'claude' },
    ))).resolves.toMatchObject({ providerId: 'provider-a', model: 'model-a' });
  });
});

describe('RouteLeaseTargetResolver subscription boundaries', () => {
  it.each([
    [
      { kind: 'account', providerId: 'claude', accountId: 'account-a' },
      { preferredAccountId: 'account-a', boundAccountFallbackPolicy: 'strict' },
    ],
    [
      { kind: 'account-group', providerId: 'claude', group: 'team-a' },
      { preferredAccountGroup: 'team-a', boundAccountFallbackPolicy: 'strict' },
    ],
    [
      { kind: 'account-pool', providerId: 'claude' },
      { preferredAccountId: undefined, preferredAccountGroup: undefined },
    ],
  ] as const)('projects target %j without widening its boundary', async (upstream, expected) => {
    const registry: SubscriptionRegistryLike = {
      getProfile: (providerId) => providerId === 'claude' ? subscriptionProfile() : null,
    };
    setSubscriptionRegistryForOutbound(registry);
    const subscriptions = { assertAvailable: vi.fn(async () => {}) };
    const source = configSource([]);
    const resolver = new RouteLeaseTargetResolver(source, { subscriptions });

    const route = await resolver.resolve(request(upstream, {
      runtime: 'claude',
      model: 'claude-sonnet-4-5',
    }));

    expect(route).toMatchObject({
      providerId: 'claude',
      model: 'claude-sonnet-4-5',
      authMode: 'subscription',
      ...expected,
    });
    expect(route.requestedModel).toBeUndefined();
    expect(subscriptions.assertAvailable).toHaveBeenCalledWith(upstream, 'claude-sonnet-4-5');
    expect(source.getProvider).toHaveBeenCalledWith('claude');
  });

  it('rejects missing subscription providers and unavailable registered transformers', async () => {
    const subscriptions = { assertAvailable: vi.fn(async () => {}) };
    const resolver = new RouteLeaseTargetResolver(configSource([]), { subscriptions });
    await expect(resolver.resolve(request(
      { kind: 'account-pool', providerId: 'claude' },
      { runtime: 'claude', model: 'claude-sonnet-4-5' },
    ))).rejects.toMatchObject({ code: 'upstream_not_found' });

    setSubscriptionRegistryForOutbound({
      getProfile: (providerId) => providerId === 'claude'
        ? subscriptionProfile({ providerTransformerNames: ['missing-transformer'] })
        : null,
    });
    await expect(resolver.resolve(request(
      { kind: 'account-pool', providerId: 'claude' },
      { runtime: 'claude', model: 'claude-sonnet-4-5' },
    ))).rejects.toMatchObject({ code: 'format_unsupported' });
  });
});
