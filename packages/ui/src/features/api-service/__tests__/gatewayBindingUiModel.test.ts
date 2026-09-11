import { describe, expect, it } from 'vitest';

import type { GatewayBinding } from '@/daemon/types';

import {
  bindingsForClientKey,
  bindingTargetLabel,
  buildDirectUpstreamOptions,
  decodeDirectUpstreamValue,
  encodeDirectUpstreamValue,
  legacyDirectUpstream,
  routeForBinding,
  setBindingForClientKey,
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

describe('direct-upstream value codec', () => {
  it('round-trips every target kind (a group name may contain colons)', () => {
    const targets = [
      { kind: 'provider' as const, providerId: 'openrouter' },
      { kind: 'account-pool' as const, providerId: 'claude' },
      { kind: 'account-group' as const, providerId: 'claude', group: 'team:a' },
      { kind: 'account' as const, providerId: 'kimi', accountId: 'acct-1' },
    ];
    for (const target of targets) {
      expect(decodeDirectUpstreamValue(encodeDirectUpstreamValue(target))).toEqual(target);
    }
    expect(encodeDirectUpstreamValue(undefined)).toBe('');
    expect(decodeDirectUpstreamValue('')).toBeNull();
    expect(decodeDirectUpstreamValue('nonsense')).toBeNull();
    expect(legacyDirectUpstream('relay')).toEqual({ kind: 'provider', providerId: 'relay' });
    expect(legacyDirectUpstream(undefined)).toBeUndefined();
  });

  it('builds options from providers plus claude/kimi subscription resources only', () => {
    const t = (key: string, opts?: Record<string, unknown>): string =>
      key === 'upstreams.memberCount' ? `members:${opts?.count}` : key;
    const providerAccounts = {
      claude: [
        { id: 'a1', group: 'team', label: '主账号' },
        { id: 'a2', group: 'team', label: undefined },
      ],
      codex: [{ id: 'c1', group: 'default' }], // NOT same-wire — excluded
    } as unknown as Parameters<typeof buildDirectUpstreamOptions>[1];
    const options = buildDirectUpstreamOptions(
      [{ id: 'openrouter', name: 'OpenRouter' } as never],
      providerAccounts,
      t,
    );
    expect(options.map((option) => option.value)).toEqual([
      'pool:claude',
      'group:claude:team',
      'account:claude:a1',
      'account:claude:a2',
      'provider:openrouter',
    ]);
  });
});
