/**
 * Account token configuration contracts.
 *
 * Holds the subscription account-token types the `@omnicross/*` packages
 * consume: the four provider token configs (claude / codex / gemini /
 * opencodego) plus their auth/status enums, the nested-account entry and
 * sanitized shapes, and the OAuth exchange request types.
 */

import type {
  OpenCodeGoTokenConfig,
} from './subscription-types';

/**
 * Authorization method (general)
 */
export type AuthMethod = 'oauth' | 'manual';

/**
 * Claude specific authorization method (includes setup_token)
 */
export type ClaudeAuthMethod = 'oauth' | 'setup_token' | 'manual';

/**
 * Subscription level for Claude accounts
 */
export type SubscriptionLevel = 'Free' | 'Pro' | 'Max';

/**
 * Token configuration status
 */
export type TokenStatus = 'unconfigured' | 'authorized' | 'configured' | 'expired' | 'error';

/**
 * Machine-readable credential-sync warning code (external-cli-sync).
 *
 * - `external-divergent`: the external CLI's native credential file (e.g.
 *   `~/.claude/.credentials.json`) holds a DIFFERENT, fresher credential than
 *   the stored account — the stored refresh token may have been rotated out.
 * - `external-not-rotated`: a refresh failed and the external file holds the
 *   SAME dead credential — a genuine revocation, re-login is required.
 * - `duplicate-token`: two accounts of one provider share the same credential —
 *   refreshing one will invalidate the other (single-use refresh tokens).
 */
export type SyncWarningCode = 'external-divergent' | 'external-not-rotated' | 'duplicate-token';

/**
 * Claude token configuration
 */
export type ClaudeTokenConfig = {
  authMethod: ClaudeAuthMethod;
  status: TokenStatus;
  subscriptionLevel?: SubscriptionLevel;
  // OAuth tokens
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes?: string[];
  // Setup Token specific
  isSetupToken?: boolean;
  setupTokenExpiresAt?: string;
  // Metadata
  lastRefreshedAt?: string;
  errorMessage?: string;
  /** Persisted credential-sync warning (external-cli-sync); cleared on a
   *  successful refresh / import. */
  syncWarning?: SyncWarningCode;
};

/**
 * Codex (OpenAI) token configuration
 */
export type CodexTokenConfig = {
  authMethod: AuthMethod;
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
  /** Persisted credential-sync warning (external-cli-sync); cleared on a
   *  successful refresh / import. */
  syncWarning?: SyncWarningCode;
};

/**
 * Gemini token configuration
 */
export type GeminiTokenConfig = {
  authMethod: AuthMethod;
  status: TokenStatus;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  lastRefreshedAt?: string;
  errorMessage?: string;
};

/**
 * A single subscription account entry. The provider's existing token config
 * is carried verbatim under a nested `tokens` field; entry metadata
 * (`id`/`label`/`createdAt`) is kept cleanly separate from token material so
 * the daemon secrets walker can recurse into `tokens` unambiguously.
 *
 * See design.md D2 (nested-tokens shape).
 */
export type SubscriptionAccountEntry<TConfig> = {
  /** Stable, generated id (`crypto.randomUUID()`). */
  id: string;
  /** User-supplied label; default "账号 N" / "Account N". */
  label?: string;
  /** ISO creation timestamp. */
  createdAt?: string;
  /**
   * Scheduling precedence in the account pool (subscription-account-scheduling).
   * Lower = higher precedence; default `50` when absent (CRS `parseInt(x,10) || 50`
   * parity). OPTIONAL — an existing `tokens.json` without it parses unchanged and
   * every account defaults to 50.
   */
  priority?: number;
  /**
   * ISO timestamp of the last time this account was selected to serve a request
   * (subscription-account-scheduling LRU tie-break input). OPTIONAL, best-effort
   * throttled persist — the selector's in-memory overlay is the authoritative live
   * value; an account without it sorts as least-recently-used (timestamp `0`).
   */
  lastUsedAt?: string;
  /** The provider's existing token config, verbatim. */
  tokens: TConfig;
};

/**
 * Complete account tokens configuration (internal use).
 *
 * The four top-level provider blocks (`claude`/`codex`/`gemini`/`opencodego`)
 * are ALWAYS a byte-equal MIRROR of the active account's token config (design
 * D1). The `<provider>Accounts` arrays + `active<Provider>AccountId` pointers
 * are NEW siblings the downstream subscription chain never reads.
 */
export type AccountTokensConfig = {
  claude?: ClaudeTokenConfig;
  codex?: CodexTokenConfig;
  gemini?: GeminiTokenConfig;
  opencodego?: OpenCodeGoTokenConfig;
  // Per-provider account collections + active pointer (multi-account).
  claudeAccounts?: SubscriptionAccountEntry<ClaudeTokenConfig>[];
  activeClaudeAccountId?: string;
  codexAccounts?: SubscriptionAccountEntry<CodexTokenConfig>[];
  activeCodexAccountId?: string;
  geminiAccounts?: SubscriptionAccountEntry<GeminiTokenConfig>[];
  activeGeminiAccountId?: string;
  opencodegoAccounts?: SubscriptionAccountEntry<OpenCodeGoTokenConfig>[];
  activeOpencodegoAccountId?: string;
  updatedAt: string;
};

/**
 * Sanitized view of a single subscription account (frontend display).
 * NEVER carries raw token material (no accessToken/refreshToken/idToken/apiKey).
 */
export type SubscriptionAccountSanitized = {
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
  /**
   * Scheduling precedence (subscription-account-scheduling) — editable in the
   * admin accounts view so an operator can order a pool. Absent ⇒ default 50.
   */
  priority?: number;
  /**
   * ISO timestamp of the last scheduler selection (display-only in the admin
   * accounts view). Absent ⇒ never selected (or the best-effort persist has not
   * yet flushed).
   */
  lastUsedAt?: string;
  /**
   * Credential-sync warning for this account (external-cli-sync). Carries the
   * persisted code when one was recorded by a failed refresh, plus the
   * list-time computed codes (`external-divergent` / `duplicate-token`).
   */
  syncWarning?: SyncWarningCode;
  /**
   * Live scheduling-health state (subscription-account-health) — in-memory, never
   * persisted. Absent / `'healthy'` ⇒ eligible; the rest mean the account is
   * currently excluded from the pool (multi-account) or would surface the
   * upstream's error (single-account). Secret-free.
   */
  health?: 'healthy' | 'rate_limited' | 'overloaded' | 'transient' | 'blocked';
  /**
   * ISO instant the current health cooldown elapses (absent for healthy /
   * permanently-blocked). Lets the admin view render "rate-limited until …".
   */
  cooldownUntil?: string;
};

/**
 * OAuth authorization parameters
 */
export type OAuthParams = {
  authUrl: string;
  codeVerifier: string;
  state: string;
};

/**
 * Token exchange request
 */
export type TokenExchangeRequest = {
  authorizationCode: string;
  codeVerifier: string;
  state: string;
};
