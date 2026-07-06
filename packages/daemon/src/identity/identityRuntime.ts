/**
 * identityRuntime — connects the core client-fingerprint identity store to the
 * daemon's persisted account entries (subscription-client-fingerprint #7, P2).
 *
 * Mirrors `getSharedAccountHealth().configure(...)` at boot: `applyFingerprintConfig`
 * `configure`s the shared `SubscriptionIdentityStore` (enabled + UA baseline) from
 * the persisted `fingerprint` segment, and — when ENABLED — SEEDS the in-memory
 * store from each account's persisted `identity` (so a claude account's replayed
 * identity survives restart) and installs a write-through persistence port (so a
 * first-seen freeze / TTL refresh is durably written onto the account entry).
 *
 * DISABLED / absent ⇒ the store stays disabled and the persistence port is cleared
 * ⇒ `applyFingerprint` is a strict no-op ⇒ outbound headers byte-identical.
 *
 * Core imports NOTHING from the daemon — the daemon supplies the port here (the
 * `setUpstreamProxyResolver` / `setWebhookSink` precedent). Boot-time only (like
 * `accountHealth`); a config change takes effect on restart.
 *
 * @module @omnicross/daemon/identity/identityRuntime
 */

import type {
  AccountClientIdentity,
  AccountTokensConfig,
} from '@omnicross/contracts/account-tokens-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import type { FingerprintConfig } from '@omnicross/core';
import { getSharedIdentityStore } from '@omnicross/core/provider-proxy/identity/SubscriptionIdentityStore';

import { type DaemonProvider, DAEMON_PROVIDER_KEYS, listAccounts } from '../ports/account-multi';

/**
 * The narrow credential-store surface the fingerprint runtime consumes: the full
 * (decrypted) config for boot seeding + a best-effort per-account identity write.
 * The concrete `JsonSubscriptionCredentialStore` structurally satisfies this.
 */
export interface FingerprintCredentialStore {
  getFullConfig(): Promise<AccountTokensConfig>;
  setAccountIdentity(
    providerId: SubscriptionProviderId,
    accountId: string,
    identity: AccountClientIdentity,
  ): Promise<void>;
}

/**
 * Apply the persisted `fingerprint` segment to the shared identity store at boot:
 * configure enabled/UA; when enabled, seed from persisted account identities and
 * install the write-through persistence port. When disabled, clear the port (the
 * in-memory captures, if any, stay inert because `applyFingerprint` gates on
 * `isEnabled()`).
 */
export async function applyFingerprintConfig(
  config: FingerprintConfig | undefined,
  credentialStore: FingerprintCredentialStore,
): Promise<void> {
  const store = getSharedIdentityStore();
  const enabled = config?.enabled === true;
  store.configure({ enabled, ua: config?.ua ?? null });

  if (!enabled) {
    store.setPersistence(null);
    return;
  }

  await seedIdentities(store, credentialStore);
  store.setPersistence({
    persist: (providerId, accountId, identity) => {
      // Best-effort durable write — the store already swallows a synchronous
      // throw; guard the async rejection too so nothing surfaces on the hot path.
      void credentialStore
        .setAccountIdentity(providerId as SubscriptionProviderId, accountId, identity)
        .catch(() => {
          /* persistence is best-effort */
        });
    },
  });
}

/** Seed the store from every account's persisted `identity` (no-overwrite). */
async function seedIdentities(
  store: ReturnType<typeof getSharedIdentityStore>,
  credentialStore: FingerprintCredentialStore,
): Promise<void> {
  let config: AccountTokensConfig;
  try {
    config = await credentialStore.getFullConfig();
  } catch {
    return;
  }
  for (const provider of Object.keys(DAEMON_PROVIDER_KEYS) as DaemonProvider[]) {
    for (const account of listAccounts(config, provider)) {
      if (account.identity) store.seed(provider, account.id, account.identity);
    }
  }
}
