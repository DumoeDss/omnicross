import type { AccountTokensConfig } from '@omnicross/contracts/account-tokens-types';
import { __resetSharedAccountAllowanceSchedulingForTests, getSharedAccountAllowanceScheduling } from '@omnicross/core/pipeline/AccountAllowanceScheduling';
import { __resetSharedAccountAllowanceStoreForTests, getSharedAccountAllowanceStore } from '@omnicross/core/pipeline/AccountAllowanceStore';
import { SubscriptionAccountHealth } from '@omnicross/core/pipeline/SubscriptionAccountHealth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveSelectedToken } from '../scheduler/accountSelection';
import { SubscriptionAccountSelector } from '../scheduler/SubscriptionAccountSelector';
import type { SubscriptionCredentialStore } from '../ports/credential-store';

const NOW = Date.now();

function store(ids: string[] = ['a', 'b']) {
  const config: AccountTokensConfig = {
    updatedAt: '', activeAntigravityAccountId: 'a',
    antigravityAccounts: ids.map((id) => ({ id, createdAt: new Date(NOW).toISOString(),
      tokens: { authMethod: 'oauth', status: 'authorized', accessToken: `token-${id}` } })),
  };
  const tokens = {
    getFullConfig: async () => config,
    getAccessTokenForAccount: vi.fn(async (_provider: string, id: string) => `token-${id}`),
  } as unknown as SubscriptionCredentialStore;
  const select = (model: string, extra: Record<string, unknown> = {}) => resolveSelectedToken(
    new SubscriptionAccountSelector(), tokens, 'antigravity', undefined, async () => 'token-a',
    { resolvedModel: model, now: NOW, ...extra },
  );
  return { config, tokens, select };
}

function disableClaude() {
  getSharedAccountAllowanceStore().set({
    providerId: 'antigravity', accountId: 'a', source: 'oauth-usage-api',
    observedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(),
    windows: [{ id: 'anthropic:weekly', label: 'Claude', scope: 'model-family', modelFamily: 'claude',
      disabled: true, usedPercent: null, state: 'fresh', resetsAt: new Date(NOW + 60_000).toISOString() }],
  });
}

beforeEach(() => {
  __resetSharedAccountAllowanceStoreForTests();
  __resetSharedAccountAllowanceSchedulingForTests();
  getSharedAccountAllowanceScheduling().configure({ enabled: true, demoteAtPercent: 80, pauseAtPercent: 98, priorityPenalty: 100 });
});

describe('Antigravity account selection', () => {
  it('routes around a disabled family without blocking other families', async () => {
    const { select } = store();
    disableClaude();
    expect(await select('claude-opus-4-6')).toBe('token-b');
    expect(await select('gemini-3-pro')).toBe('token-a');
  });

  it('enforces family pauses for a sole account and strict bindings', async () => {
    const { select } = store(['a']);
    disableClaude();
    await expect(select('claude-opus-4-6')).rejects.toMatchObject({ code: 'account_allowance_exhausted' });
    await expect(select('claude-opus-4-6', { preferredAccountId: 'a' })).rejects.toThrow();
    expect(await select('gemini-3-pro')).toBe('token-a');
  });

  it('still checks account health and model support', async () => {
    const { config, select } = store();
    const health = new SubscriptionAccountHealth({ now: () => NOW });
    health.recordUpstreamOutcome('antigravity', 'a', { status: 503, now: NOW });
    expect(await select('gemini-3-pro', { health })).toBe('token-b');
    config.antigravityAccounts![0]!.supportedModels = ['claude-opus-4-6'];
    expect(await select('gemini-3-pro')).toBe('token-b');
  });

  it('keeps stale disabled snapshots and disabled policy from stranding accounts', async () => {
    const { select } = store();
    disableClaude();
    expect(await select('claude-opus-4-6', { now: NOW + 60_001 })).toBe('token-a');
    getSharedAccountAllowanceScheduling().configure(undefined);
    expect(await select('claude-opus-4-6')).toBe('token-a');
  });
});
