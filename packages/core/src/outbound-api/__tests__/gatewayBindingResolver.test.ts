import { describe, expect, it } from 'vitest';

import { mergeServerConfig, normalizeServerConfig } from '../apiServerConfig';
import { resolveGatewayBinding } from '../gatewayBindingResolver';
import type { EndpointRoutingConfig, GatewayBinding } from '../types';

const fallback: EndpointRoutingConfig = {
  endpoint: 'responses',
  useSubscription: true,
  modelMap: { codex: 'codex,global-codex', mini: 'codex,global-mini' },
};

function binding(overrides: Partial<GatewayBinding> = {}): GatewayBinding {
  return {
    id: 'binding-1',
    name: 'Codex team',
    enabled: true,
    endpoint: 'responses',
    target: { kind: 'account-group', providerId: 'codex', group: 'team-a' },
    fallback: 'fail',
    modelMap: { codex: 'gpt-5.3-codex', mini: 'gpt-5.3-codex-mini' },
    ...overrides,
  };
}

describe('gateway binding resolution', () => {
  it('prefers an exact client-key binding and projects an account group', () => {
    const result = resolveGatewayBinding({
      bindings: [binding(), binding({ id: 'key-route', apiKeyIds: ['client-a'], priority: 500 })],
      apiKeyId: 'client-a',
      endpoint: 'responses',
      requestedModel: 'gpt-5.3-codex',
      fallbackEndpointConfig: fallback,
    });
    expect(result.source).toBe('binding');
    expect(result.binding?.id).toBe('key-route');
    expect(result.config).toMatchObject({
      useSubscription: true,
      boundAccountGroup: 'team-a',
      boundAccountFallbackPolicy: 'strict',
      modelMap: { codex: 'codex,gpt-5.3-codex' },
    });
  });

  it('uses the legacy endpoint when a global-fallback binding has no route', () => {
    const result = resolveGatewayBinding({
      bindings: [binding({ fallback: 'global', modelMap: {} })],
      apiKeyId: 'client-a',
      endpoint: 'responses',
      requestedModel: 'gpt-5.3-codex',
      fallbackEndpointConfig: fallback,
    });
    expect(result).toEqual({ source: 'global', config: fallback });
  });

  it('projects provider key bindings without changing provider DTOs', () => {
    const result = resolveGatewayBinding({
      bindings: [
        binding({
          target: { kind: 'provider', providerId: 'openrouter', keyId: 'key-2' },
          fallback: 'global',
          modelMap: { codex: 'openai/gpt-5.3-codex', mini: 'openai/gpt-5-mini' },
        }),
      ],
      apiKeyId: 'client-a',
      endpoint: 'responses',
      requestedModel: 'gpt-5.3-codex',
      fallbackEndpointConfig: fallback,
    });
    expect(result.config).toMatchObject({
      useSubscription: false,
      boundKeyId: 'key-2',
      boundKeyFallbackPolicy: 'pool',
      modelMap: { codex: 'openrouter,openai/gpt-5.3-codex' },
    });
  });
});
describe('gateway binding persistence compatibility', () => {
  it('normalizes bindings and preserves them through an unrelated legacy patch', () => {
    const config = normalizeServerConfig({
      enabled: false,
      networkBinding: false,
      endpoints: [fallback],
      bindings: [binding({ apiKeyIds: [' client-a ', 'client-a'] })],
    });
    expect(config.bindings).toHaveLength(1);
    expect(config.bindings?.[0].apiKeyIds).toEqual(['client-a']);

    const merged = mergeServerConfig(config, { networkBinding: true });
    expect(merged.bindings).toEqual(config.bindings);
  });

  it('drops malformed and duplicate-id bindings', () => {
    const config = normalizeServerConfig({
      bindings: [
        binding(),
        binding({ name: 'duplicate' }),
        { ...binding({ id: 'bad' }), target: { kind: 'account', providerId: '', accountId: '' } },
      ],
    });
    expect(config.bindings?.map((item) => item.id)).toEqual(['binding-1']);
  });
});
