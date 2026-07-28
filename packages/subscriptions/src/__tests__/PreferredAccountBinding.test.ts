/**
 * Preferred-account binding tests (provider/subscription duality) — when an
 * outbound endpoint binds a specific account (`EndpointRoutingConfig.boundAccountId`
 * → `RouteContext.preferredAccountId` → `AuthApplyHints.preferredAccountId`),
 * `resolveSelectedToken` resolves it DIRECTLY when schedulable, and falls back to
 * the pool only when it is missing / unschedulable / empty-token.
 */

import type { AccountTokensConfig } from '@omnicross/contracts/account-tokens-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import {
  __resetSharedAccountHealthForTests,
  getSharedAccountHealth,
} from '@omnicross/core/pipeline/SubscriptionAccountHealth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubscriptionCredentialStore } from '../ports/credential-store';
import { SubscriptionAccountService } from '../SubscriptionAccountService';

/** A fake claude credential store over an in-memory account list. */
function makeStore(
  accounts: Array<{ id: string; token: string | null }>,
  activeId: string | undefined,
): SubscriptionCredentialStore & { getAccessTokenForAccount: ReturnType<typeof vi.fn> } {
  const config: AccountTokensConfig = {
    updatedAt: '',
    claude: activeId
      ? { authMethod: 'oauth', status: 'authorized', accessToken: accounts.find((a) => a.id === activeId)?.token ?? undefined }
      : undefined,
    claudeAccounts: accounts.map((a) => ({
      id: a.id,
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

beforeEach(() => __resetSharedAccountHealthForTests());

describe('preferred-account binding', () => {
  it('resolves the preferred account directly even when it is not the active one', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }, { id: 'B', token: 'AT-B' }], 'A');
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;

    // Preferred = B (a non-active sibling) ⇒ B's token, resolved by id.
    expect(await bearer(strategy, { preferredAccountId: 'B' })).toBe('Bearer AT-B');
    expect(tokens.getAccessTokenForAccount).toHaveBeenCalledWith('claude', 'B');
  });

  it('falls back to the pool when the preferred account is unschedulable', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }, { id: 'B', token: 'AT-B' }], 'A');
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;

    // B (preferred) is rate-limited ⇒ unschedulable ⇒ pool serves the active A.
    getSharedAccountHealth().recordUpstreamOutcome('claude', 'B', {
      status: 429,
      resetHeaderSeconds: futureResetSeconds(),
    });

    expect(await bearer(strategy, { preferredAccountId: 'B' })).toBe('Bearer AT-A');
  });

  it('falls back to the pool when the preferred id is unknown', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }, { id: 'B', token: 'AT-B' }], 'A');
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;

    // Unknown id is not in the pool ⇒ fall through to the active account.
    expect(await bearer(strategy, { preferredAccountId: 'ZZZ' })).toBe('Bearer AT-A');
  });

  it('no preferred id ⇒ pool auto-schedule (active account)', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }, { id: 'B', token: 'AT-B' }], 'A');
    const strategy = new SubscriptionAccountService(tokens).getStrategy('claude')!;

    expect(await bearer(strategy)).toBe('Bearer AT-A');
  });
});
