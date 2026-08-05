import { describe, expect, it } from 'vitest';

import type { GatewayBinding, GatewayBindingTarget } from '@/daemon/types';

import {
  bindingDraftFromBinding,
  bindingFromDraft,
  bindingMatchesTarget,
  bindingModelSummary,
  canSaveBindingDraft,
  newBindingDraft,
  parseBindingList,
} from '../upstreamBindingModel';

const providerTarget: GatewayBindingTarget = { kind: 'provider', providerId: 'openai' };

function binding(overrides: Partial<GatewayBinding> = {}): GatewayBinding {
  return {
    id: 'route-1',
    name: 'Primary',
    enabled: true,
    endpoint: 'responses',
    target: { kind: 'account', providerId: 'codex', accountId: 'acct-a' },
    fallback: 'fail',
    modelMap: { codex: 'codex,gpt-5.6-sol' },
    ...overrides,
  };
}

describe('upstreamBindingModel', () => {
  it('matches account, group, and provider resources by stable target identity', () => {
    expect(bindingMatchesTarget(binding(), { kind: 'account', providerId: 'codex', accountId: 'acct-a' })).toBe(true);
    expect(bindingMatchesTarget(binding(), { kind: 'account', providerId: 'codex', accountId: 'acct-b' })).toBe(false);

    const groupBinding = binding({ target: { kind: 'account-group', providerId: 'claude', group: 'team' } });
    expect(bindingMatchesTarget(groupBinding, { kind: 'account-group', providerId: 'claude', group: 'team' })).toBe(true);

    const providerBinding = binding({ target: { kind: 'provider', providerId: 'openai', keyId: 'key-a' } });
    expect(bindingMatchesTarget(providerBinding, providerTarget)).toBe(true);
    expect(bindingMatchesTarget(providerBinding, { kind: 'provider', providerId: 'other' })).toBe(false);
  });

  it('converts a provider draft into a deterministic binding and clamps priority', () => {
    const draft = {
      ...newBindingDraft(),
      name: '  Client route  ',
      endpoint: 'chat' as const,
      apiKeyIds: ['client-a'],
      priority: '20000',
      fallback: 'global' as const,
      providerKeyId: 'provider-key-a',
      modelsText: 'gpt-5.6-sol\ngpt-5.6-sol, gpt-5.6-luna',
    };

    expect(bindingFromDraft(draft, providerTarget, () => 'route-fixed')).toEqual({
      id: 'route-fixed',
      name: 'Client route',
      enabled: true,
      endpoint: 'chat',
      apiKeyIds: ['client-a'],
      target: { kind: 'provider', providerId: 'openai', keyId: 'provider-key-a' },
      fallback: 'global',
      priority: 10_000,
      models: ['gpt-5.6-sol', 'gpt-5.6-luna'],
      dispatchMode: 'list',
    });
  });

  it('round-trips editable fields and validates endpoint-specific model requirements', () => {
    const original = binding({
      apiKeyIds: ['client-a'],
      priority: 25,
      modelMap: { codex: 'codex,gpt-5.6-sol', mini: '' },
    });
    const draft = bindingDraftFromBinding(original);
    expect(draft.apiKeyIds).toEqual(['client-a']);
    expect(draft.priority).toBe('25');
    expect(canSaveBindingDraft(draft)).toBe(true);
    expect(bindingModelSummary(original)).toBe('codex:gpt-5.6-sol');

    expect(canSaveBindingDraft(newBindingDraft())).toBe(false);
    expect(parseBindingList(' a, b\na ')).toEqual(['a', 'b']);
  });
});
