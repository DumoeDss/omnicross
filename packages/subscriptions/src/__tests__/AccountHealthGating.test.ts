/**
 * Account-health gating tests (subscription-account-health, tasks 2.3 / 4.2 / 7.3)
 * — the shared health tracker, wired through `SubscriptionAccountService`, makes a
 * MULTI-account provider route around an unhealthy sibling, restores it once its
 * cooldown clears, keeps the SINGLE-account path byte-identical even when unhealthy
 * (degraded policy), and evicts + re-selects on a null by-id token (#1 [Minor]).
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

/** A reset header far enough in the future that the account stays cooling. */
function futureResetSeconds(): number {
  return Math.floor(Date.now() / 1000) + 3600;
}

beforeEach(() => __resetSharedAccountHealthForTests());

describe('health gating — multi-account routing', () => {
  it('routes AROUND a rate-limited account to the healthy sibling', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }, { id: 'B', token: 'AT-B' }], 'A');
    const svc = new SubscriptionAccountService(tokens);
    const strategy = svc.getStrategy('claude')!;

    // A (the active account) is rate-limited → every request must serve B by id.
    getSharedAccountHealth().recordUpstreamOutcome('claude', 'A', {
      status: 429,
      resetHeaderSeconds: futureResetSeconds(),
    });

    for (let i = 0; i < 4; i++) {
      expect(await bearer(strategy)).toBe('Bearer AT-B');
    }
    expect(tokens.getAccessTokenForAccount).toHaveBeenCalledWith('claude', 'B');
    expect(tokens.getAccessTokenForAccount).not.toHaveBeenCalledWith('claude', 'A');
  });

  it('returns the account to rotation once its cooldown clears (2xx)', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }, { id: 'B', token: 'AT-B' }], 'A');
    const svc = new SubscriptionAccountService(tokens);
    const strategy = svc.getStrategy('claude')!;
    const health = getSharedAccountHealth();

    health.recordUpstreamOutcome('claude', 'A', { status: 429, resetHeaderSeconds: futureResetSeconds() });
    expect(await bearer(strategy)).toBe('Bearer AT-B'); // A excluded

    // A recovers (a success clears its rate limit) → both back in rotation.
    health.recordUpstreamOutcome('claude', 'A', { status: 200 });
    const seen = new Set<string | undefined>();
    for (let i = 0; i < 6; i++) seen.add(await bearer(strategy));
    expect(seen).toEqual(new Set(['Bearer AT-A', 'Bearer AT-B']));
  });

  it('all-unhealthy multi-account pool falls to the active account (upstream surfaces the error)', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }, { id: 'B', token: 'AT-B' }], 'A');
    const svc = new SubscriptionAccountService(tokens);
    const strategy = svc.getStrategy('claude')!;
    const health = getSharedAccountHealth();
    health.recordUpstreamOutcome('claude', 'A', { status: 429, resetHeaderSeconds: futureResetSeconds() });
    health.recordUpstreamOutcome('claude', 'B', { status: 429, resetHeaderSeconds: futureResetSeconds() });

    // 0 schedulable → active-mirror path serves the active account (whose upstream
    // returns its own authoritative 429 next time); never a silent healthy pick.
    expect(await bearer(strategy)).toBe('Bearer AT-A');
  });
});

describe('single-account degraded policy — zero regression', () => {
  it('a sole rate-limited account still serves via the active path (never stranded)', async () => {
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }], 'A');
    const svc = new SubscriptionAccountService(tokens);
    const strategy = svc.getStrategy('claude')!;
    getSharedAccountHealth().recordUpstreamOutcome('claude', 'A', {
      status: 429,
      resetHeaderSeconds: futureResetSeconds(),
    });

    // Health does NOT exclude a sole account: byte-identical active path, NO by-id.
    expect(await bearer(strategy)).toBe('Bearer AT-A');
    expect(tokens.getAccessTokenForAccount).not.toHaveBeenCalled();
  });
});

describe('#1 [Minor] — null by-id token eviction + re-select', () => {
  it('re-selects (and marks unhealthy) when the picked account yields a null token', async () => {
    // A active; B the only healthy sibling but its by-id token is NULL; C cooling.
    const tokens = makeStore([{ id: 'A', token: 'AT-A' }, { id: 'B', token: null }, { id: 'C', token: 'AT-C' }], 'A');
    const svc = new SubscriptionAccountService(tokens);
    const strategy = svc.getStrategy('claude')!;
    const health = getSharedAccountHealth();

    // Leave B the sole schedulable non-active account (A active is rate-limited, C
    // cooling), so the router targets B by id — whose token is null.
    health.recordUpstreamOutcome('claude', 'A', { status: 429, resetHeaderSeconds: futureResetSeconds() });
    health.recordUpstreamOutcome('claude', 'C', { status: 429, resetHeaderSeconds: futureResetSeconds() });

    // B's null token → evict B's affinity + mark B transient + re-select. No other
    // non-active healthy pick remains, so it falls to the active account A.
    expect(await bearer(strategy, { sessionKey: 's1' })).toBe('Bearer AT-A');
    // B was tried by id (then abandoned) and is now marked unhealthy.
    expect(tokens.getAccessTokenForAccount).toHaveBeenCalledWith('claude', 'B');
    expect(health.isSchedulable('claude', 'B')).toBe(false);
  });
});
