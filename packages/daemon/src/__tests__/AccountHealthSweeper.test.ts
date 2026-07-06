/**
 * AccountHealthSweeper tests (subscription-account-health, task 5.4) — the daemon
 * tick surfaces recovered accounts through the tracker hook, nudges a near-expiry
 * OAuth token refresh for a recovered account, no-ops when nothing recovered, and
 * holds its single-sweep re-entrancy guard.
 */

import type { AccountTokensConfig } from '@omnicross/contracts/account-tokens-types';
import type { Logger } from '@omnicross/core';
import { SubscriptionAccountHealth } from '@omnicross/core/pipeline/SubscriptionAccountHealth';
import { describe, expect, it, vi } from 'vitest';

import { AccountHealthSweeper } from '../AccountHealthSweeper';
import type { JsonSubscriptionCredentialStore } from '../ports/JsonSubscriptionCredentialStore';

const noopLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** A fake store exposing only what the sweeper touches. */
function makeStore(config: AccountTokensConfig, refresh = vi.fn(async () => true)): {
  store: JsonSubscriptionCredentialStore;
  refreshAccountById: ReturnType<typeof vi.fn>;
} {
  const store = {
    getFullConfig: vi.fn(async () => config),
    refreshAccountById: refresh,
  } as unknown as JsonSubscriptionCredentialStore;
  return { store, refreshAccountById: refresh };
}

function claudeConfig(account: { id: string; expiresAt?: string }): AccountTokensConfig {
  return {
    updatedAt: '',
    claudeAccounts: [
      {
        id: account.id,
        createdAt: '2026-01-01T00:00:00.000Z',
        tokens: {
          authMethod: 'oauth',
          status: 'authorized',
          accessToken: 'AT',
          refreshToken: 'RT',
          expiresAt: account.expiresAt,
        },
      },
    ],
    activeClaudeAccountId: undefined,
  };
}

describe('AccountHealthSweeper', () => {
  it('emits a recovery signal and nudges a near-expiry OAuth refresh', async () => {
    let clock = 1_000_000;
    const health = new SubscriptionAccountHealth({ now: () => clock });
    // Account whose token expires within the 5-min lead window → refresh nudged.
    const expiresAt = new Date(clock + 2 * 60_000).toISOString();
    const { store, refreshAccountById } = makeStore(claudeConfig({ id: 'A', expiresAt }));
    const sweeper = new AccountHealthSweeper(store, health, noopLogger);

    const recovered: string[] = [];
    health.onRecovered((e) => recovered.push(e.accountId));

    health.recordUpstreamOutcome('claude', 'A', { status: 429, resetHeaderSeconds: 2000 });
    clock = 2_000_000; // past the reset

    await sweeper.sweep(clock);

    expect(recovered).toEqual(['A']);
    expect(refreshAccountById).toHaveBeenCalledWith('claude', 'A');
  });

  it('does NOT refresh a recovered account whose token is not near expiry', async () => {
    let clock = 1_000_000;
    const health = new SubscriptionAccountHealth({ now: () => clock });
    const expiresAt = new Date(clock + 60 * 60_000).toISOString(); // an hour out
    const { store, refreshAccountById } = makeStore(claudeConfig({ id: 'A', expiresAt }));
    const sweeper = new AccountHealthSweeper(store, health, noopLogger);

    health.recordUpstreamOutcome('claude', 'A', { status: 429, resetHeaderSeconds: 2000 });
    clock = 2_000_000;
    await sweeper.sweep(clock);

    expect(refreshAccountById).not.toHaveBeenCalled();
  });

  it('is a no-op when nothing recovered', async () => {
    const health = new SubscriptionAccountHealth();
    const getFullConfig = vi.fn(async () => claudeConfig({ id: 'A' }));
    const refreshAccountById = vi.fn(async () => true);
    const store = { getFullConfig, refreshAccountById } as unknown as JsonSubscriptionCredentialStore;
    const sweeper = new AccountHealthSweeper(store, health, noopLogger);

    await sweeper.sweep();
    // Nothing recovered ⇒ the store is never even read for a refresh nudge.
    expect(refreshAccountById).not.toHaveBeenCalled();
  });

  it('holds the single-sweep re-entrancy guard', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const health = new SubscriptionAccountHealth();
    const sweepSpy = vi.spyOn(health, 'sweepRecoveries');
    const getFullConfig = vi.fn(async () => {
      await gate; // hold the first sweep open
      return claudeConfig({ id: 'A' });
    });
    // Force a recovery so the first sweep reaches getFullConfig.
    health.recordUpstreamOutcome('claude', 'A', { status: 429, resetHeaderSeconds: 1 });
    const store = { getFullConfig, refreshAccountById: vi.fn() } as unknown as JsonSubscriptionCredentialStore;
    const sweeper = new AccountHealthSweeper(store, health, noopLogger);

    const first = sweeper.sweep(Date.now()); // in-flight (awaiting the gate)
    await sweeper.sweep(Date.now()); // guarded → returns immediately, no sweepRecoveries
    expect(sweepSpy).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });
});
