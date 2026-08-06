import { describe, expect, it } from 'vitest';

import { mergeServerConfig, normalizeServerConfig } from '../apiServerConfig';
import {
  gatewayBindingToEndpointConfig,
  resolveGatewayBinding,
  resolveGatewayModelMapping,
} from '../gatewayBindingResolver';
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

  it('yields a next-fallback route with no mapping to the following candidate', () => {
    const result = resolveGatewayBinding({
      bindings: [
        binding({ id: 'empty', fallback: 'next', modelMap: {}, priority: 1 }),
        binding({ id: 'serving', fallback: 'next', priority: 2 }),
      ],
      apiKeyId: 'client-a',
      endpoint: 'responses',
      requestedModel: 'gpt-5.3-codex',
    });
    expect(result.source).toBe('binding');
    expect(result.binding?.id).toBe('serving');
  });

  it('keeps the sole candidate selected when nothing can serve, so its own route error surfaces', () => {
    const result = resolveGatewayBinding({
      bindings: [binding({ id: 'empty', fallback: 'next', modelMap: {} })],
      apiKeyId: 'client-a',
      endpoint: 'responses',
      requestedModel: 'gpt-5.3-codex',
    });
    expect(result.source).toBe('binding');
    expect(result.binding?.id).toBe('empty');
  });

  it('projects provider key bindings without changing provider DTOs', () => {
    const result = resolveGatewayBinding({
      bindings: [
        binding({
          target: { kind: 'provider', providerId: 'openrouter', keyId: 'key-2' },
          fallback: 'next',
          modelMap: { codex: 'openai/gpt-5.3-codex', mini: 'openai/gpt-5-mini' },
        }),
      ],
      apiKeyId: 'client-a',
      endpoint: 'responses',
      requestedModel: 'gpt-5.3-codex',
    });
    expect(result.config).toMatchObject({
      useSubscription: false,
      boundKeyId: 'key-2',
      boundKeyFallbackPolicy: 'pool',
      modelMap: { codex: 'openrouter,openai/gpt-5.3-codex' },
    });
  });

  it('passes the requested model through when a downstream has no mapping', () => {
    const result = resolveGatewayBinding({
      bindings: [binding({
        modelMode: 'passthrough',
        modelMap: undefined,
        keyScope: 'selected',
        apiKeyIds: ['client-a'],
      })],
      apiKeyId: 'client-a',
      endpoint: 'responses',
      requestedModel: 'gpt-5.9-future',
    });
    expect(result.source).toBe('binding');
    expect(result.config.modelMap).toEqual({
      codex: 'codex,gpt-5.9-future',
      mini: 'codex,gpt-5.9-future',
    });
  });

  it.each([
    ['messages', {
      modelMap: {
        fable: 'glm,client-model',
        opus: 'glm,client-model',
        sonnet: 'glm,client-model',
        haiku: 'glm,client-model',
      },
    }],
    ['responses', {
      modelMap: {
        codex: 'glm,client-model',
        mini: 'glm,client-model',
      },
    }],
    ['chat', { models: ['glm,client-model'], dispatchMode: 'list' }],
    ['gemini', { defaultModel: 'glm,client-model', backgroundModel: 'glm,client-model' }],
  ] as const)('projects %s passthrough into its legacy resolver shape', (endpoint, expected) => {
    const config = gatewayBindingToEndpointConfig(binding({
      endpoint,
      target: { kind: 'provider', providerId: 'glm' },
      modelMode: 'passthrough',
      modelMap: undefined,
    }), 'client-model');

    expect(config).toMatchObject({
      endpoint,
      useSubscription: false,
      ...expected,
    });
  });

  it('keeps a selected-scope downstream inaccessible until a key binds it', () => {
    const result = resolveGatewayBinding({
      bindings: [binding({
        keyScope: 'selected',
        apiKeyIds: undefined,
        modelMode: 'passthrough',
      })],
      apiKeyId: 'client-a',
      endpoint: 'responses',
      requestedModel: 'gpt-5.9-future',
    });
    expect(result).toEqual({ source: 'none' });
  });

  it('resolves exact mappings before ordered wildcard mappings', () => {
    const mappings = [
      { source: '*', target: 'fallback-model' },
      { source: 'claude-sonnet-*', target: 'glm-4.7' },
      { source: 'claude-sonnet-4-5', target: 'glm-exact' },
    ];
    expect(resolveGatewayModelMapping(mappings, 'claude-sonnet-4-5')).toBe('glm-exact');
    expect(resolveGatewayModelMapping(mappings, 'claude-sonnet-4-6')).toBe('fallback-model');
  });

  it('projects a generic wildcard mapping through the selected upstream', () => {
    const result = resolveGatewayBinding({
      bindings: [binding({
        endpoint: 'messages',
        target: { kind: 'provider', providerId: 'glm' },
        modelMode: 'mapped',
        modelMap: undefined,
        modelMappings: [{ source: 'claude-sonnet-*', target: 'glm-4.7' }],
      })],
      apiKeyId: 'client-a',
      endpoint: 'messages',
      requestedModel: 'claude-sonnet-4-5',
    });
    expect(result.source).toBe('binding');
    expect(result.config.modelMap).toMatchObject({
      sonnet: 'glm,glm-4.7',
      opus: 'glm,glm-4.7',
      haiku: 'glm,glm-4.7',
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
    expect(config.bindings?.[0].keyScope).toBe('selected');
    expect(config.bindings?.[0].modelMode).toBe('mapped');

    const merged = mergeServerConfig(config, { networkBinding: true });
    expect(merged.bindings).toEqual(config.bindings);
  });

  it('normalizes an empty new downstream as model passthrough and preserves an empty selected key scope', () => {
    const config = normalizeServerConfig({
      bindings: [binding({
        modelMap: {},
        modelMode: undefined,
        keyScope: 'selected',
        apiKeyIds: [],
      })],
    });
    expect(config.bindings?.[0]).toMatchObject({
      keyScope: 'selected',
      modelMode: 'passthrough',
    });
    expect(config.bindings?.[0].apiKeyIds).toBeUndefined();
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
