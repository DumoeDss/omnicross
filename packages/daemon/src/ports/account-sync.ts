/**
 * account-sync — pure decision logic for external-CLI credential sync and
 * credential-conflict warnings (external-cli-sync).
 *
 * Host-clean like `account-multi`: no I/O, no encryption — the store performs
 * the reads/writes and feeds plaintext token blocks in.
 *
 * Three concerns:
 *  1. IMPORT DECISION — after a failed OAuth refresh, decide whether the
 *     external CLI's native store holds a credential worth importing. Guard
 *     (fail closed): the external lineage must have actually ROTATED (a
 *     different refresh token) OR its access token must still be valid —
 *     otherwise the file holds the same dead credential we just tried (a true
 *     revocation, not a missed rotation).
 *  2. DIVERGENCE DETECTION — list-time check that the external store has
 *     rotated PAST the stored account (different refresh token AND a strictly
 *     later expiry). Warn-only: the stored refresh token may already be dead.
 *  3. DUPLICATE DETECTION — two accounts of one provider sharing the same
 *     credential: refreshing one invalidates the other (single-use refresh
 *     tokens), so both rows get a warning.
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

/** Don't treat an access token within this window of expiry as "still valid". */
export const IMPORT_EXPIRY_MARGIN_MS = 60_000;

/** Outcome of the import decision. */
export type ExternalImportDecision = 'import' | 'not-rotated' | 'no-credential';

/** Narrow read view over a token block's credential fields. */
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
 * Decide whether the external credential is worth importing after a failed
 * refresh (concern 1). `import` ⇒ the external refresh token rotated past ours
 * OR the external access token is still valid (absent expiry ⇒ non-expiring).
 */
export function decideExternalImport(
  captured: AnyTokenConfig,
  external: ExternalCliCredentials | null,
  now: number = Date.now(),
): ExternalImportDecision {
  if (!external?.accessToken) return 'no-credential';
  const capturedRt = viewOf(captured).refreshToken;
  const hasNewRefresh = Boolean(external.refreshToken && external.refreshToken !== capturedRt);
  const accessStillValid = external.expiresAt
    ? Date.parse(external.expiresAt) > now + IMPORT_EXPIRY_MARGIN_MS
    : true;
  return hasNewRefresh || accessStillValid ? 'import' : 'not-rotated';
}

/**
 * Build the imported token block (carry forward unrelated captured fields,
 * e.g. authMethod / subscriptionLevel / email). Clears any prior error /
 * sync-warning state.
 */
export function buildImportedTokens(
  captured: AnyTokenConfig,
  external: ExternalCliCredentials,
): AnyTokenConfig {
  const imported = {
    ...captured,
    accessToken: external.accessToken,
    status: 'authorized',
    errorMessage: undefined,
    syncWarning: undefined,
    lastRefreshedAt: new Date().toISOString(),
  } as Record<string, unknown>;
  if (external.refreshToken) imported.refreshToken = external.refreshToken;
  if (external.expiresAt) imported.expiresAt = external.expiresAt;
  else delete imported.expiresAt; // unknown expiry ⇒ non-expiring, not stale
  if (external.idToken) imported.idToken = external.idToken;
  if (external.scopes) imported.scopes = external.scopes;
  return imported as AnyTokenConfig;
}

/**
 * Build a FRESH account token block from an external CLI credential (the
 * "import existing CLI login" path — no prior account to carry fields from).
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
 * Detect whether the external store has rotated PAST the stored account
 * (concern 2): a different refresh token AND a strictly later (or unbounded)
 * expiry. A merely-different access token with the SAME refresh token is the
 * normal "we refreshed, the CLI file is stale" direction — NOT a hazard.
 */
export function isExternalDivergent(
  stored: AnyTokenConfig,
  external: ExternalCliCredentials | null,
): boolean {
  if (!external?.accessToken || !external.refreshToken) return false;
  const view = viewOf(stored);
  if (!view.refreshToken || external.refreshToken === view.refreshToken) return false;
  const storedExp = view.expiresAt ? Date.parse(view.expiresAt) : NaN;
  const externalExp = external.expiresAt ? Date.parse(external.expiresAt) : Infinity;
  // External fresher (or stored expiry unknown) ⇒ our refresh token may be dead.
  return !Number.isFinite(storedExp) || externalExp > storedExp;
}

/**
 * Find accounts that share the same credential (concern 3). Compares the
 * refresh token (OAuth providers) falling back to apiKey / accessToken (manual
 * / static-key providers). Returns the ids of EVERY account participating in a
 * collision (both sides warn — either refresh kills the other).
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
