/**
 * identityRuntime — boot seed + write-through persistence for the client
 * fingerprint identity store (subscription-client-fingerprint #7, P2).
 */

import type {
  AccountClientIdentity,
  AccountTokensConfig,
} from '@omnicross/contracts/account-tokens-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import {
  __resetSharedIdentityStoreForTests,
  getSharedIdentityStore,
} from '@omnicross/core/provider-proxy/identity/SubscriptionIdentityStore';
import { afterEach, describe, expect, it } from 'vitest';

import * as accountMulti from '../../ports/account-multi';
import { applyFingerprintConfig, type FingerprintCredentialStore } from '../identityRuntime';

/** A minimal in-memory credential store that persists identities into its config. */
class FakeCredentialStore implements FingerprintCredentialStore {
  writes: Array<{ providerId: string; accountId: string; identity: AccountClientIdentity }> = [];
  constructor(public config: AccountTokensConfig) {}
  async getFullConfig(): Promise<AccountTokensConfig> {
    return this.config;
  }
  async setAccountIdentity(
    providerId: SubscriptionProviderId,
    accountId: string,
    identity: AccountClientIdentity,
  ): Promise<void> {
    this.writes.push({ providerId, accountId, identity });
    accountMulti.setAccountIdentity(this.config, providerId, accountId, identity);
  }
}

function configWithClaudeAccount(identity?: AccountClientIdentity): AccountTokensConfig {
  return {
    claudeAccounts: [
      {
        id: 'acc-1',
        tokens: { authMethod: 'oauth', status: 'authorized' },
        ...(identity ? { identity } : {}),
      },
    ],
    activeClaudeAccountId: 'acc-1',
    updatedAt: new Date().toISOString(),
  };
}

afterEach(() => {
  __resetSharedIdentityStoreForTests();
});

describe('applyFingerprintConfig', () => {
  it('enabled ⇒ seeds the store from a persisted account identity (survives restart)', async () => {
    const store = new FakeCredentialStore(
      configWithClaudeAccount({ headers: { 'x-stainless-lang': 'seeded' }, capturedAt: 7 }),
    );
    await applyFingerprintConfig({ enabled: true }, store);
    const shared = getSharedIdentityStore();
    expect(shared.isEnabled()).toBe(true);
    expect(shared.replay('claude', 'acc-1')).toEqual({ 'x-stainless-lang': 'seeded' });
  });

  it('enabled ⇒ a first-seen capture writes through to the account entry', async () => {
    const store = new FakeCredentialStore(configWithClaudeAccount());
    await applyFingerprintConfig({ enabled: true }, store);
    getSharedIdentityStore().capture('claude', 'acc-1', { 'x-stainless-lang': 'js', 'user-agent': 'ua' });
    // Allow the fire-and-forget void promise to settle.
    await Promise.resolve();
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].identity.headers).toEqual({ 'x-stainless-lang': 'js', 'user-agent': 'ua' });
    // Round-trips onto the persisted config.
    expect(store.config.claudeAccounts?.[0].identity?.headers).toEqual({
      'x-stainless-lang': 'js',
      'user-agent': 'ua',
    });
  });

  it('enabled ⇒ applies the operator UA baseline', async () => {
    const store = new FakeCredentialStore(configWithClaudeAccount());
    await applyFingerprintConfig({ enabled: true, ua: 'baseline/2' }, store);
    expect(getSharedIdentityStore().uaBaseline()).toBe('baseline/2');
  });

  it('disabled ⇒ store stays disabled and NO write-through is wired', async () => {
    const store = new FakeCredentialStore(configWithClaudeAccount());
    await applyFingerprintConfig({ enabled: false }, store);
    const shared = getSharedIdentityStore();
    expect(shared.isEnabled()).toBe(false);
    shared.capture('claude', 'acc-1', { 'x-stainless-lang': 'js' });
    await Promise.resolve();
    expect(store.writes).toHaveLength(0);
  });
});

describe('account-multi setAccountIdentity', () => {
  it('sets, reads back, and clears a per-account identity', () => {
    const config = configWithClaudeAccount();
    expect(accountMulti.setAccountIdentity(config, 'claude', 'acc-1', {
      headers: { 'x-stainless-lang': 'js' },
      capturedAt: 1,
    }).ok).toBe(true);
    expect(config.claudeAccounts?.[0].identity?.headers).toEqual({ 'x-stainless-lang': 'js' });
    // Clear.
    expect(accountMulti.setAccountIdentity(config, 'claude', 'acc-1', undefined).ok).toBe(true);
    expect(config.claudeAccounts?.[0].identity).toBeUndefined();
    // Unknown id rejected.
    expect(accountMulti.setAccountIdentity(config, 'claude', 'nope', undefined).ok).toBe(false);
  });
});
