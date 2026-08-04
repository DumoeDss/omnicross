/**
 * account-sync pure helpers for explicit external-CLI imports and
 * managed-account duplicate-credential warnings.
 *
 * This module is host-clean: no I/O and no automatic native-file recovery or
 * divergence decisions. Native CLI credentials are consumed only by the
 * explicit admin import path in the credential store.
 *
 * @module @omnicross/daemon/ports/account-sync
 */

import type {
  ClaudeTokenConfig,
  CodexTokenConfig,
  SubscriptionAccountEntry,
} from '@omnicross/contracts/account-tokens-types';

import type { AnyTokenConfig } from './account-multi';
import type { ExternalCliCredentials, ExternalCliProvider } from './external-cli-credentials';

/** Narrow credential fields used by duplicate detection. */
interface CredentialView {
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  expiresAt?: string;
}
function viewOf(tokens: AnyTokenConfig): CredentialView {
  return tokens as CredentialView;
}

/**
 * Build a FRESH account token block from an external CLI credential (the
 * "import existing CLI login" path no prior account to carry fields from).
 */
export function buildTokensFromExternal(
  provider: ExternalCliProvider,
  external: ExternalCliCredentials,
): ClaudeTokenConfig | CodexTokenConfig {
  const base = {
    authMethod: 'oauth' as const,
    status: 'authorized' as const,
    accessToken: external.accessToken,
    lastRefreshedAt: new Date().toISOString(),
  };
  if (provider === 'claude') {
    const tokens: ClaudeTokenConfig = { ...base };
    if (external.refreshToken) tokens.refreshToken = external.refreshToken;
    if (external.expiresAt) tokens.expiresAt = external.expiresAt;
    if (external.scopes) tokens.scopes = external.scopes;
    return tokens;
  }
  const tokens: CodexTokenConfig = { ...base };
  if (external.refreshToken) tokens.refreshToken = external.refreshToken;
  if (external.expiresAt) tokens.expiresAt = external.expiresAt;
  if (external.idToken) tokens.idToken = external.idToken;
  return tokens;
}

/**
 * Find accounts that share the same credential (concern 3). Compares the
 * refresh token (OAuth providers) falling back to apiKey / accessToken (manual
 * / static-key providers). Returns the ids of EVERY account participating in a
 * collision (both sides warn either refresh kills the other).
 */
export function findDuplicateCredentialIds(
  accounts: SubscriptionAccountEntry<AnyTokenConfig>[],
): Set<string> {
  const byCredential = new Map<string, string[]>();
  for (const account of accounts) {
    const view = viewOf(account.tokens);
    const credential = view.refreshToken ?? view.apiKey ?? view.accessToken;
    if (!credential) continue;
    const ids = byCredential.get(credential) ?? [];
    ids.push(account.id);
    byCredential.set(credential, ids);
  }
  const duplicates = new Set<string>();
  for (const ids of byCredential.values()) {
    if (ids.length > 1) for (const id of ids) duplicates.add(id);
  }
  return duplicates;
}
