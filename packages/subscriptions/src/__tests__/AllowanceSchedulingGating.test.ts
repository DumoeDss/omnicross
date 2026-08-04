import type { AccountTokensConfig } from '@omnicross/contracts/account-tokens-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import {
  __resetSharedAccountAllowanceSchedulingForTests,
  AccountAllowanceExhaustedError,
  getSharedAccountAllowanceScheduling,
} from '@omnicross/core/pipeline/AccountAllowanceScheduling';
import {
  __resetSharedAccountAllowanceStoreForTests,
  getSharedAccountAllowanceStore,
} from '@omnicross/core/pipeline/AccountAllowanceStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubscriptionCredentialStore } from '../ports/credential-store';
import { SubscriptionAccountService } from '../SubscriptionAccountService';

const NOW = Date.now();

function makeStore(
  accounts: Array<{ id: string; token: string | null; priority?: number }>,
  activeId: string,
): SubscriptionCredentialStore & { getAccessTokenForAccount: ReturnType<typeof vi.fn> } {
  const config: AccountTokensConfig = {
    updatedAt: '',
    codex: {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: accounts.find((account) => account.id === activeId)?.token ?? undefined,
    },
    codexAccounts: accounts.map((account) => ({
      id: account.id,
      priority: account.priority,
      createdAt: '2026-01-01T00:00:00.000Z',
      tokens: {
        authMethod: 'oauth',
        status: 'authorized',
        accessToken: account.token ?? undefined,
      },
    })),
    activeCodexAccountId: activeId,
  };
  const getAccessTokenForAccount = vi.fn(async (_providerId: SubscriptionProviderId, id: string) =>
    accounts.find((account) => account.id === id)?.token ?? null,
  );
  return {
    getFullConfig: vi.fn(async () => config),
    getValidClaudeAccessToken: vi.fn(async () => null),
    getValidOpenCodeGoApiKey: vi.fn(async () => null),
    refreshClaudeToken: vi.fn(async () => false),
    refreshCodexToken: vi.fn(async () => false),
    refreshGeminiToken: vi.fn(async () => false),
    getAccessTokenForAccount,
    refreshAccountToken: vi.fn(async () => true),
    touchAccountLastUsed: vi.fn(async () => undefined),
  } as unknown as SubscriptionCredentialStore & {
    getAccessTokenForAccount: ReturnType<typeof vi.fn>;
  };
}

function observe(accountId: string, usedPercent: number, state: 'fresh' | 'stale' = 'fresh'): void {
  getSharedAccountAllowanceStore().set({
    providerId: 'codex',
    accountId,
    source: 'response-headers',
    observedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 15 * 60_000).toISOString(),
    windows: [{
      id: 'primary',
      label: '5 hours',
      scope: 'all',
      usedPercent,
      resetsAt: new Date(NOW + 60 * 60_000).toISOString(),
      state,
    }],
  });
}

async function bearer(
  strategy: { applyHeaders: (headers: Record<string, string>, hints?: unknown) => Promise<void> },
): Promise<string | undefined> {
  const headers: Record<string, string> = {};
  await strategy.applyHeaders(headers, { now: NOW });
  return headers.Authorization;
}

beforeEach(() => {
  __resetSharedAccountAllowanceSchedulingForTests();
  __resetSharedAccountAllowanceStoreForTests();
});

describe('allowance-aware account scheduling', () => {
  it('demotes a high-usage account behind a lower-usage sibling', async () => {
    const tokens = makeStore([
      { id: 'A', token: 'AT-A', priority: 0 },
      { id: 'B', token: 'AT-B', priority: 50 },
    ], 'A');
    observe('A', 85);
    observe('B', 20);
    getSharedAccountAllowanceScheduling().configure({
      enabled: true,
      demoteAtPercent: 80,
      pauseAtPercent: 98,
      priorityPenalty: 100,
    });

    const strategy = new SubscriptionAccountService(tokens).getStrategy('codex')!;
    expect(await bearer(strategy)).toBe('Bearer AT-B');
    expect(tokens.getAccessTokenForAccount).toHaveBeenCalledWith('codex', 'B');
  });

  it('routes around one paused account and records the decision', async () => {
    const tokens = makeStore([
      { id: 'A', token: 'AT-A' },
      { id: 'B', token: 'AT-B' },
    ], 'A');
    observe('A', 99);
    observe('B', 20);
    const scheduling = getSharedAccountAllowanceScheduling();
    scheduling.configure({
      enabled: true,
      demoteAtPercent: 80,
      pauseAtPercent: 98,
      priorityPenalty: 100,
    });

    const strategy = new SubscriptionAccountService(tokens).getStrategy('codex')!;
    expect(await bearer(strategy)).toBe('Bearer AT-B');
    expect(scheduling.getHistory()).toEqual([
      expect.objectContaining({ providerId: 'codex', accountId: 'A', action: 'pause' }),
    ]);
  });

  it('throws a structured 429 signal when every otherwise eligible account is paused', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }], 'A');
    observe('A', 99);
    getSharedAccountAllowanceScheduling().configure({
      enabled: true,
      demoteAtPercent: 80,
      pauseAtPercent: 98,
      priorityPenalty: 100,
    });

    const strategy = new SubscriptionAccountService(tokens).getStrategy('codex')!;
    await expect(bearer(strategy)).rejects.toMatchObject({
      name: 'AccountAllowanceExhaustedError',
      code: 'account_allowance_exhausted',
      status: 429,
      providerId: 'codex',
    } satisfies Partial<AccountAllowanceExhaustedError>);
  });

  it('does not fall back to a paused active account after the eligible sibling has no token', async () => {
    const tokens = makeStore([
      { id: 'A', token: 'AT-A' },
      { id: 'B', token: null },
    ], 'A');
    observe('A', 99);
    observe('B', 20);
    getSharedAccountAllowanceScheduling().configure({
      enabled: true,
      demoteAtPercent: 80,
      pauseAtPercent: 98,
      priorityPenalty: 100,
    });

    const strategy = new SubscriptionAccountService(tokens).getStrategy('codex')!;
    await expect(bearer(strategy)).rejects.toBeInstanceOf(AccountAllowanceExhaustedError);
    expect(tokens.getAccessTokenForAccount).toHaveBeenCalledWith('codex', 'B');
  });

  it('never gates on stale telemetry', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }], 'A');
    observe('A', 100, 'stale');
    getSharedAccountAllowanceScheduling().configure({
      enabled: true,
      demoteAtPercent: 80,
      pauseAtPercent: 98,
      priorityPenalty: 100,
    });

    const strategy = new SubscriptionAccountService(tokens).getStrategy('codex')!;
    expect(await bearer(strategy)).toBe('Bearer AT-A');
  });
});
