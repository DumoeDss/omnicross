import { describe, expect, it } from 'vitest';

import type { GatewayBinding } from '@/daemon/types';

import {
  bindingsForClientKey,
  bindingTargetLabel,
  routeForBinding,
  summarizeBindingCoverage,
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
  it('routes account, group, and provider bindings back to their Upstreams detail', () => {
    expect(routeForBinding(binding())).toEqual({
      page: 'upstreams',
      upstreamKind: 'account',
      upstreamFilter: 'account',
      accountProvider: 'codex',
      accountId: 'acct-a',
    });
    expect(routeForBinding(binding({ target: { kind: 'account-group', providerId: 'claude', group: 'team' } }))).toEqual({
      page: 'upstreams',
      upstreamKind: 'account-group',
      upstreamFilter: 'account-group',
      upstreamProviderId: 'claude',
      upstreamGroup: 'team',
    });
    expect(routeForBinding(binding({ target: { kind: 'provider', providerId: 'openai', keyId: 'key-a' } }))).toEqual({
      page: 'upstreams',
      upstreamKind: 'provider',
      upstreamFilter: 'provider',
      upstreamProviderId: 'openai',
    });
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
