import { describe, expect, it } from 'vitest';

import type { GatewayBinding } from '@/daemon/types';

import {
  bindKeyToUpstream,
  bindingsForClientKey,
  bindingTargetLabel,
  routeForBinding,
  setBindingForClientKey,
  summarizeBindingCoverage,
  upstreamEndpointsForTarget,
} from '../gatewayBindingUiModel';

function binding(overrides: Partial<GatewayBinding> = {}): GatewayBinding {
  return {
    id: 'route-1',
    name: 'Route',
    enabled: true,
    endpoint: 'responses',
    target: { kind: 'account', providerId: 'codex', accountId: 'acct-a' },
    fallback: 'fail',
    modelMap: { codex: 'codex,gpt-5.6-sol' },
    ...overrides,
  };
}

describe('gatewayBindingUiModel', () => {
  it('opens every binding in the downstream route workspace', () => {
    expect(routeForBinding(binding())).toEqual({
      page: 'upstreams',
      upstreamTab: 'routes',
      downstreamId: 'route-1',
    });
  });

  it('binds and unbinds downstreams from the API-key side', () => {
    const routes = [
      binding({ id: 'global', keyScope: 'all' }),
      binding({ id: 'selected', keyScope: 'selected', apiKeyIds: ['client-b'] }),
    ];
    const afterGlobalUnbind = setBindingForClientKey(
      routes,
      ['client-a', 'client-b'],
      'client-a',
      'global',
      false,
    );
    expect(afterGlobalUnbind[0]).toMatchObject({ keyScope: 'selected', apiKeyIds: ['client-b'] });
    expect(bindingsForClientKey(afterGlobalUnbind, 'client-a')).toEqual([]);

    const afterBind = setBindingForClientKey(
      afterGlobalUnbind,
      ['client-a', 'client-b'],
      'client-a',
      'selected',
      true,
    );
    expect(afterBind[1].apiKeyIds).toEqual(['client-b', 'client-a']);
    expect(bindingsForClientKey(afterBind, 'client-a').map((item) => item.id)).toEqual(['selected']);
  });

  it('finds enabled unscoped and key-scoped routes for a client key', () => {
    const routes = [
      binding({ id: 'global' }),
      binding({ id: 'mine', apiKeyIds: ['client-a'] }),
      binding({ id: 'other', apiKeyIds: ['client-b'] }),
      binding({ id: 'disabled', enabled: false }),
    ];
    expect(bindingsForClientKey(routes, 'client-a').map((item) => item.id)).toEqual(['global', 'mine']);
  });

  it('summarizes only enabled coverage and formats target labels', () => {
    const routes = [
      binding({ id: 'a', apiKeyIds: ['client-a'] }),
      binding({ id: 'b', endpoint: 'messages', target: { kind: 'account-group', providerId: 'claude', group: 'team' } }),
      binding({ id: 'c', enabled: false, endpoint: 'chat' }),
    ];
    expect(summarizeBindingCoverage(routes)).toEqual({ enabled: 2, endpoints: 2, keyScoped: 1 });
    expect(bindingTargetLabel(routes[0])).toBe('codex / acct-a');
    expect(bindingTargetLabel(routes[1])).toBe('claude / team');
    expect(bindingTargetLabel(binding({ target: { kind: 'provider', providerId: 'openai' } }))).toBe('openai');
  });
});

describe('key→upstream direct binding', () => {
  it('serves a BYO provider from every ingress; subscriptions from messages/responses (claude adds chat)', () => {
    expect(upstreamEndpointsForTarget({ kind: 'provider', providerId: 'openrouter' }))
      .toEqual(['chat', 'responses', 'messages', 'gemini']);
    expect(upstreamEndpointsForTarget({ kind: 'account-pool', providerId: 'claude' }))
      .toEqual(['messages', 'responses', 'chat']);
    expect(upstreamEndpointsForTarget({ kind: 'account', providerId: 'codex', accountId: 'a' }))
      .toEqual(['messages', 'responses']);
  });

  it('creates one passthrough route per servable endpoint for an unbound key', () => {
    const next = bindKeyToUpstream(
      [],
      'client-a',
      {
        key: 'provider:openrouter',
        label: 'OpenRouter',
        detail: 'provider',
        target: { kind: 'provider', providerId: 'openrouter' },
        endpoints: upstreamEndpointsForTarget({ kind: 'provider', providerId: 'openrouter' }),
      },
      (endpoint) => `proto:${endpoint}`,
    );
    expect(next).toHaveLength(4);
    expect(next.map((route) => route.endpoint).sort()).toEqual(['chat', 'gemini', 'messages', 'responses']);
    for (const route of next) {
      expect(route.modelMode).toBe('passthrough');
      expect(route.keyScope).toBe('selected');
      expect(route.apiKeyIds).toEqual(['client-a']);
      expect(route.target).toEqual({ kind: 'provider', providerId: 'openrouter' });
      expect(route.name).toBe(`OpenRouter · proto:${route.endpoint}`);
    }
  });

  it('reuses an existing same-target route instead of duplicating it', () => {
    const existing = binding({
      id: 'route-1',
      endpoint: 'messages',
      target: { kind: 'account', providerId: 'claude', accountId: 'acct-a' },
      keyScope: 'selected',
      apiKeyIds: ['client-b'],
    });
    const next = bindKeyToUpstream(
      [existing],
      'client-a',
      {
        key: 'account:claude:acct-a',
        label: 'Team',
        detail: 'claude',
        target: { kind: 'account', providerId: 'claude', accountId: 'acct-a' },
        endpoints: upstreamEndpointsForTarget({ kind: 'account', providerId: 'claude', accountId: 'acct-a' }),
      },
      (endpoint) => endpoint,
    );
    // messages reused (key added), responses + chat created — no duplicates.
    expect(next).toHaveLength(3);
    expect(next[0]).toMatchObject({ id: 'route-1', apiKeyIds: ['client-b', 'client-a'] });
    expect(next.slice(1).map((route) => route.endpoint).sort()).toEqual(['chat', 'responses']);
    expect(next[1]).toMatchObject({ apiKeyIds: ['client-a'] });
    expect(next[2]).toMatchObject({ apiKeyIds: ['client-a'] });
    // Binding the same key again is a no-op.
    const again = bindKeyToUpstream(
      next,
      'client-a',
      {
        key: 'account:claude:acct-a',
        label: 'Team',
        detail: 'claude',
        target: { kind: 'account', providerId: 'claude', accountId: 'acct-a' },
        endpoints: upstreamEndpointsForTarget({ kind: 'account', providerId: 'claude', accountId: 'acct-a' }),
      },
      (endpoint) => endpoint,
    );
    expect(again).toEqual(next);
  });

  it('never mutates the input routes array', () => {
    const existing = binding({ id: 'route-1', endpoint: 'chat', keyScope: 'selected', apiKeyIds: ['client-b'] });
    const frozen = [existing];
    bindKeyToUpstream(
      frozen,
      'client-a',
      {
        key: 'provider:openrouter',
        label: 'OpenRouter',
        detail: 'provider',
        target: { kind: 'provider', providerId: 'openrouter' },
        endpoints: ['chat'],
      },
      (endpoint) => endpoint,
    );
    expect(frozen[0].apiKeyIds).toEqual(['client-b']);
  });
});
