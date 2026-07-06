/**
 * types-accounts.ts — hand-mirrored daemon admin-API DTOs for the Accounts /
 * Subscriptions page (`/admin/api/accounts`).
 *
 * SECRET SPINE: the sanitized read shapes NEVER carry a raw token; the write
 * input shapes carry ONLY the per-provider allowlisted fields the daemon's
 * `validateTokenBody` accepts. The write RESPONSE is status-only (a
 * `SubscriptionListEntry`) — the submitted token never round-trips.
 */

/** Stable IDs for built-in subscription providers. */
export type SubscriptionProviderId = 'claude' | 'codex' | 'gemini' | 'opencodego';

/** Token lifecycle status. */
export type TokenStatus = 'unconfigured' | 'authorized' | 'configured' | 'expired' | 'error';

/** Credential-sync warning code (external-cli-sync, computed by the daemon). */
export type SyncWarningCode = 'external-divergent' | 'external-not-rotated' | 'duplicate-token';

/** Status of a single subscription provider's credential. */
export interface SubscriptionStatusEntry {
  providerId: SubscriptionProviderId;
  ok: boolean;
  reason?:
    | 'missing-credential'
    | 'expired'
    | 'reauth-required'
    | 'refresh-failed'
    | 'not-refreshable'
    | 'unknown';
  /** ISO timestamp when the credential expires (OAuth providers only). */
  expiresAt?: string;
}

/** Catalog entry (`accounts` array from `GET /accounts`). */
export interface SubscriptionListEntry {
  providerId: SubscriptionProviderId;
  displayName: string;
  kind: 'pass-through' | 'oauth-bearer' | 'static-bearer';
  credentialStatus: SubscriptionStatusEntry;
}

/**
 * Sanitized view of a single account (`providerAccounts[providerId][]`).
 * NEVER carries raw token material.
 *
 * The daemon's sanitizer already projects the non-secret metadata below
 * (`authMethod` / `subscriptionLevel` / `lastRefreshedAt` / `isSetupToken`); the
 * app surfaces them in the expandable account-row detail panel. They remain
 * optional — a row missing any of them simply omits that detail line.
 */
export interface SubscriptionAccountSanitized {
  id: string;
  label?: string;
  status: TokenStatus;
  authMethod?: string;
  subscriptionLevel?: string;
  expiresAt?: string;
  lastRefreshedAt?: string;
  isSetupToken?: boolean;
  hasAccessToken: boolean;
  isActive: boolean;
  /** Editable scheduling precedence (subscription-account-scheduling); default 50
   *  when absent (lower = higher precedence). */
  priority?: number;
  /** Display-only ISO timestamp of the last scheduler selection. */
  lastUsedAt?: string;
  /** Credential-sync warning for this account (external-cli-sync). */
  syncWarning?: SyncWarningCode;
  /** Live scheduling-health state (subscription-account-health); in-memory. */
  health?: 'healthy' | 'rate_limited' | 'overloaded' | 'transient' | 'blocked';
  /** ISO instant the current health cooldown elapses (absent for healthy/blocked). */
  cooldownUntil?: string;
}

/** `GET /admin/api/accounts` response. */
export interface AccountsListResponse {
  accounts: SubscriptionListEntry[];
  providerAccounts: Record<SubscriptionProviderId, SubscriptionAccountSanitized[]>;
  /**
   * Which providers have a usable external CLI login file on the daemon's
   * machine (external-cli-sync) — drives the "import existing CLI login"
   * affordance. Pure presence booleans, never a token. Absent on older daemons.
   */
  externalCli?: { claude?: boolean; codex?: boolean };
}

// ── Per-provider token-write input shapes (allowlisted fields ONLY) ───────────
//
// These are the shapes the app's write form collects and the adapter serializes
// field-by-field (deny-by-default). Each mirrors the daemon's per-provider
// `validateTokenBody` allowlist exactly — a field outside the list is never sent.

/** Claude write input — `authMethod ∈ {oauth,setup_token,manual}`. */
export interface ClaudeTokenInput {
  authMethod: 'oauth' | 'setup_token' | 'manual';
  status: TokenStatus;
  subscriptionLevel?: 'Free' | 'Pro' | 'Max';
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  setupTokenExpiresAt?: string;
  lastRefreshedAt?: string;
  errorMessage?: string;
  scopes?: string[];
  isSetupToken?: boolean;
}

/** Codex write input — `authMethod ∈ {oauth,manual}`. */
export interface CodexTokenInput {
  authMethod: 'oauth' | 'manual';
  status: TokenStatus;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: string;
  accountId?: string;
  email?: string;
  organizationId?: string;
  lastRefreshedAt?: string;
  errorMessage?: string;
}

/** Gemini write input — `authMethod ∈ {oauth,manual}`. */
export interface GeminiTokenInput {
  authMethod: 'oauth' | 'manual';
  status: TokenStatus;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  lastRefreshedAt?: string;
  errorMessage?: string;
}

/** OpenCodeGo write input — `authMethod === 'manual'` ONLY. */
export interface OpenCodeGoTokenInput {
  authMethod: 'manual';
  status: 'unconfigured' | 'configured' | 'error';
  apiKey?: string;
  baseUrl?: string;
  zenBaseUrl?: string;
  lastRefreshedAt?: string;
  errorMessage?: string;
}

/** The discriminated union of all four write inputs. */
export type AccountTokenInput =
  | { providerId: 'claude'; input: ClaudeTokenInput }
  | { providerId: 'codex'; input: CodexTokenInput }
  | { providerId: 'gemini'; input: GeminiTokenInput }
  | { providerId: 'opencodego'; input: OpenCodeGoTokenInput };
