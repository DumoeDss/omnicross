/**
 * Preferred-account binding tests (provider/subscription duality) — when an
 * outbound endpoint binds a specific account (`EndpointRoutingConfig.boundAccountId`
 * → `RouteContext.preferredAccountId` → `AuthApplyHints.preferredAccountId`),
 * `resolveSelectedToken` resolves it DIRECTLY and fails closed when the bound
 * account cannot serve. Pool fallback is covered only through the explicit
 * `boundAccountFallbackPolicy: 'pool'` opt-in.
 */

import type { AccountTokensConfig } from '@omnicross/contracts/account-tokens-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import {
  __resetSharedAccountHealthForTests,
  getSharedAccountHealth,
} from '@omnicross/core/pipeline/SubscriptionAccountHealth';
import {
  __resetSharedAccountAllowanceSchedulingForTests,
  getSharedAccountAllowanceScheduling,
} from '@omnicross/core/pipeline/AccountAllowanceScheduling';
import {
  __resetSharedAccountAllowanceStoreForTests,
  getSharedAccountAllowanceStore,
} from '@omnicross/core/pipeline/AccountAllowanceStore';
import type { BoundAccountSelectionError } from '@omnicross/core/pipeline/BoundAccountSelectionError';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubscriptionCredentialStore } from '../ports/credential-store';
import { SubscriptionAccountService } from '../SubscriptionAccountService';

/** A fake claude credential store over an in-memory account list. */
function makeStore(
  accounts: Array<{
    id: string;
    token: string | null;
    enabled?: boolean;
    priority?: number;
    supportedModels?: string[] | Record<string, string>;
  }>,
  activeId: string | undefined,
): SubscriptionCredentialStore & { getAccessTokenForAccount: ReturnType<typeof vi.fn> } {
  const config: AccountTokensConfig = {
    updatedAt: '',
    claude: activeId
      ? { authMethod: 'oauth', status: 'authorized', accessToken: accounts.find((a) => a.id === activeId)?.token ?? undefined }
      : undefined,
    claudeAccounts: accounts.map((a) => ({
      id: a.id,
      enabled: a.enabled,
      priority: a.priority,
      supportedModels: a.supportedModels,
      createdAt: '2026-01-01T00:00:00.000Z',
      tokens: { authMethod: 'oauth', status: 'authorized', accessToken: a.token ?? undefined },
    })),
    activeClaudeAccountId: activeId,
  };
  const getAccessTokenForAccount = vi.fn(async (_p: SubscriptionProviderId, id: string) =>
    accounts.find((a) => a.id === id)?.token ?? null,
  );
  return {
    getFullConfig: vi.fn(async () => config),
    getValidClaudeAccessToken: vi.fn(async () => accounts.find((a) => a.id === activeId)?.token ?? null),
    getValidOpenCodeGoApiKey: vi.fn(async () => null),
    refreshClaudeToken: vi.fn(async () => false),
    refreshCodexToken: vi.fn(async () => false),
    refreshGeminiToken: vi.fn(async () => false),
    getAccessTokenForAccount,
    refreshAccountToken: vi.fn(async () => true),
    touchAccountLastUsed: vi.fn(async () => undefined),
  } as unknown as SubscriptionCredentialStore & { getAccessTokenForAccount: ReturnType<typeof vi.fn> };
}

async function bearer(
  strategy: { applyHeaders: (h: Record<string, string>, hints?: unknown) => Promise<void> },
  hints?: unknown,
): Promise<string | undefined> {
  const headers: Record<string, string> = {};
  await strategy.applyHeaders(headers, hints);
  return headers['Authorization'];
}

function futureResetSeconds(): number {
  return Math.floor(Date.now() / 1000) + 3600;
}

beforeEach(() => {
  __resetSharedAccountHealthForTests();
  __resetSharedAccountAllowanceSchedulingForTests();
  __resetSharedAccountAllowanceStoreForTests();
});

function expectBoundFailure(
  promise: Promise<unknown>,
  reason: BoundAccountSelectionError['reason'],
  status: number,
): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    code: 'bound_account_unavailable',
    reason,
    status,
  });
}

function pauseAccount(accountId: string): void {
  const now = Date.now();
  getSharedAccountAllowanceStore().set({
    providerId: 'claude',
    accountId,
    source: 'response-headers',
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 15 * 60_000).toISOString(),
    windows: [{
      id: 'primary',
      label: 'allowance',
      scope: 'all',
      usedPercent: 99,
      resetsAt: new Date(now + 60 * 60_000).toISOString(),
      state: 'fresh',
    }],
  });
  getSharedAccountAllowanceScheduling().configure({
    enabled: true,
    demoteAtPercent: 80,
    pauseAtPercent: 98,
    priorityPenalty: 100,
  });
}

describe('preferred-account binding', () => {
  it('resolves the preferred account directly even when it is not the active one', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }, { id: 'B', token: 'AT-B' }], 'A');
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;

    // Preferred = B (a non-active sibling) ⇒ B's token, resolved by id.
    expect(await bearer(strategy, { preferredAccountId: 'B' })).toBe('Bearer AT-B');
    expect(tokens.getAccessTokenForAccount).toHaveBeenCalledWith('claude', 'B');
  });

  it('fails closed when the bound account is unhealthy', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }, { id: 'B', token: 'AT-B' }], 'A');
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;

    // B is bound and rate-limited; strict mode must reject rather than serve A.
    getSharedAccountHealth().recordUpstreamOutcome('claude', 'B', {
      status: 429,
      resetHeaderSeconds: futureResetSeconds(),
    });

    await expectBoundFailure(
      bearer(strategy, { preferredAccountId: 'B' }),
      'unhealthy',
      503,
    );
  });

  it('fails closed when the bound id is unknown', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }, { id: 'B', token: 'AT-B' }], 'A');
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;

    // Unknown bound ids must not fall through to the active account.
    await expectBoundFailure(
      bearer(strategy, { preferredAccountId: 'ZZZ' }),
      'not-found',
      503,
    );
  });

  it('fails closed when the bound account is disabled', async () => {
    const tokens = makeStore([
      { id: 'A', token: 'AT-A' },
      { id: 'B', token: 'AT-B', enabled: false },
    ], 'A');
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;

    await expectBoundFailure(
      bearer(strategy, { preferredAccountId: 'B' }),
      'disabled',
      503,
    );
  });

  it('fails closed when the bound account does not support the resolved model', async () => {
    const tokens = makeStore([
      { id: 'A', token: 'AT-A' },
      { id: 'B', token: 'AT-B', supportedModels: ['other-model'] },
    ], 'A');
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;

    await expectBoundFailure(
      bearer(strategy, { preferredAccountId: 'B', resolvedModel: 'target-model' }),
      'model-incompatible',
      503,
    );
  });

  it('fails closed when the bound account has no usable token', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }, { id: 'B', token: null }], 'A');
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;

    await expectBoundFailure(
      bearer(strategy, { preferredAccountId: 'B' }),
      'empty-token',
      503,
    );
  });

  it('fails closed when the account store is unavailable', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }, { id: 'B', token: 'AT-B' }], 'A');
    vi.spyOn(tokens, 'getFullConfig').mockRejectedValueOnce(new Error('secret store unavailable'));
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;

    await expectBoundFailure(
      bearer(strategy, { preferredAccountId: 'B' }),
      'unavailable',
      503,
    );
  });

  it('fails closed when the bound account is paused by allowance policy', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }, { id: 'B', token: 'AT-B' }], 'A');
    pauseAccount('B');
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;

    await expectBoundFailure(
      bearer(strategy, { preferredAccountId: 'B' }),
      'allowance-paused',
      429,
    );
  });

  it('uses the pool only when the endpoint explicitly opts in', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }, { id: 'B', token: 'AT-B' }], 'A');
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;
    getSharedAccountHealth().recordUpstreamOutcome('claude', 'B', {
      status: 429,
      resetHeaderSeconds: futureResetSeconds(),
    });

    expect(await bearer(strategy, {
      preferredAccountId: 'B',
      boundAccountFallbackPolicy: 'pool',
    })).toBe('Bearer AT-A');
  });

  it('no preferred id ⇒ pool auto-schedule (active account)', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }, { id: 'B', token: 'AT-B' }], 'A');
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;

    expect(await bearer(strategy)).toBe('Bearer AT-A');
  });
});
