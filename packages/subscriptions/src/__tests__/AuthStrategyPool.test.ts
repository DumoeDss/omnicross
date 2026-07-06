/**
 * AuthStrategyPool tests (subscription-account-scheduling, task 4.8 strategy
 * wiring) — the shared selector, wired through `SubscriptionAccountService`, makes
 * a multi-account provider spread load across accounts by id, keeps a same-session
 * sequence sticky, and leaves the single-account path byte-identical (NO by-id
 * read, active getter only) — the structural zero-regression proof.
 */

import type { AccountTokensConfig } from '@omnicross/contracts/account-tokens-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import { describe, expect, it, vi } from 'vitest';

import type { SubscriptionCredentialStore } from '../ports/credential-store';
import { SubscriptionAccountService } from '../SubscriptionAccountService';

/** A fake claude credential store over an in-memory account list. */
function makeStore(
  accounts: Array<{ id: string; token: string }>,
  activeId: string | undefined,
): SubscriptionCredentialStore & {
  getAccessTokenForAccount: ReturnType<typeof vi.fn>;
  getValidClaudeAccessToken: ReturnType<typeof vi.fn>;
} {
  const config: AccountTokensConfig = {
    updatedAt: '',
    claude: activeId
      ? { authMethod: 'oauth', status: 'authorized', accessToken: accounts.find((a) => a.id === activeId)?.token }
      : undefined,
    claudeAccounts: accounts.map((a) => ({
      id: a.id,
      createdAt: '2026-01-01T00:00:00.000Z',
      tokens: { authMethod: 'oauth', status: 'authorized', accessToken: a.token },
    })),
    activeClaudeAccountId: activeId,
  };
  const getAccessTokenForAccount = vi.fn(async (_p: SubscriptionProviderId, id: string) =>
    accounts.find((a) => a.id === id)?.token ?? null,
  );
  const getValidClaudeAccessToken = vi.fn(async () =>
    accounts.find((a) => a.id === activeId)?.token ?? null,
  );
  return {
    getFullConfig: vi.fn(async () => config),
    getValidClaudeAccessToken,
    getValidOpenCodeGoApiKey: vi.fn(async () => null),
    refreshClaudeToken: vi.fn(async () => false),
    refreshCodexToken: vi.fn(async () => false),
    refreshGeminiToken: vi.fn(async () => false),
    getAccessTokenForAccount,
    refreshAccountToken: vi.fn(async () => true),
    touchAccountLastUsed: vi.fn(async () => undefined),
  } as unknown as SubscriptionCredentialStore & {
    getAccessTokenForAccount: ReturnType<typeof vi.fn>;
    getValidClaudeAccessToken: ReturnType<typeof vi.fn>;
  };
}

async function bearer(strategy: { applyHeaders: (h: Record<string, string>, hints?: unknown) => Promise<void> }, hints?: unknown): Promise<string | undefined> {
  const headers: Record<string, string> = {};
  await strategy.applyHeaders(headers, hints);
  return headers['Authorization'];
}

describe('claude strategy — account pool', () => {
  it('spreads two accounts across successive requests (by-id, no session key)', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }, { id: 'B', token: 'AT-B' }], 'A');
    const svc = new SubscriptionAccountService(tokens);
    const strategy = svc.getStrategy('claude')!;

    const first = await bearer(strategy);
    const second = await bearer(strategy);
    expect(new Set([first, second])).toEqual(new Set(['Bearer AT-A', 'Bearer AT-B']));
    // The non-active account was read BY ID (not the active mirror).
    expect(tokens.getAccessTokenForAccount).toHaveBeenCalledWith('claude', 'B');
  });

  it('sticks a same-session sequence to one account', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }, { id: 'B', token: 'AT-B' }], 'A');
    const svc = new SubscriptionAccountService(tokens);
    const strategy = svc.getStrategy('claude')!;
    const a = await bearer(strategy, { sessionKey: 'sess-1' });
    const b = await bearer(strategy, { sessionKey: 'sess-1' });
    const c = await bearer(strategy, { sessionKey: 'sess-1' });
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('single account is byte-identical: active getter only, NO by-id read', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }], 'A');
    const svc = new SubscriptionAccountService(tokens);
    const strategy = svc.getStrategy('claude')!;

    expect(await bearer(strategy)).toBe('Bearer AT-A');
    expect(tokens.getValidClaudeAccessToken).toHaveBeenCalledTimes(1);
    expect(tokens.getAccessTokenForAccount).not.toHaveBeenCalled();
  });
});
