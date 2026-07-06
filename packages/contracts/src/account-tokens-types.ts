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
 * Upstream proxy descriptor (upstream-proxy). Routes an outbound upstream call
 * through an http/https or socks5 proxy. Two interchangeable shapes:
 *  - `{ url }`      — a full proxy URL, e.g. `http://user:pass@host:1080` or
 *                     `socks5://host:1080` (userinfo carries basic-auth).
 *  - structured     — an explicit `{ type, host, port, username?, password? }`.
 *
 * `username`/`password` are SECRETS: encrypted at rest via the same envelope as
 * other credentials, masked in every sanitized/admin view, and never logged
 * (logs carry at most `host:port`). Additive everywhere it appears — absent ⇒ a
 * direct (non-proxied) call, byte-identical to before proxy support.
 */
export type ProxyConfig =
  | { url: string }
  | {
      type: 'http' | 'https' | 'socks5';
      host: string;
      port: number;
      username?: string;
      password?: string;
    };

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
  /**
   * Per-account upstream proxy override (upstream-proxy). When set, this
   * account's relay + OAuth-refresh traffic is routed through this proxy,
   * WINNING over the per-provider and global proxy layers. OPTIONAL — an
   * existing `tokens.json` without it parses unchanged (no proxy → direct). Its
   * `password` is a secret: encrypted at rest by the tokens `SecretBox` walker
   * and masked in the sanitized view.
   */
  proxy?: ProxyConfig;
  /**
   * Per-account model support + logical→actual remap (subscription-account-model-map).
   * CRS dual-format, OPTIONAL — an existing `tokens.json` without it parses
   * unchanged (the account supports every model and never remaps, byte-identical
   * to before this change):
   *  - **array** `["a","b"]` — an ALLOW-LIST: the account supports ONLY these
   *    logical models (skip-only, no remap). In a ≥2-account pool the account is
   *    routed AROUND for any other model.
   *  - **object** `{ "a": "X", "b": "Y" }` — the keys are the same allow-list AND
   *    each value is the account's ACTUAL upstream model, so a selected account
   *    remaps the logical model to its actual model on the outbound request.
   *
   * Model-support filtering only applies when the provider has ≥2 accounts (the
   * same gate as account health) — a sole account is never model-gated
   * (never-strand; the upstream stays authoritative). A sole account that must
   * serve a logical model AS a different actual model uses the OBJECT map (remap),
   * not skip.
   */
  supportedModels?: string[] | Record<string, string>;
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
 * Secret-free view of a per-account/global/provider proxy (upstream-proxy). The
 * password is NEVER carried — only a `hasPassword` presence flag plus a
 * display-safe `host:port` endpoint (userinfo stripped). Rendered in the admin
 * accounts view.
 */
export type SanitizedProxyConfig = {
  /** `'url'` when configured via a full URL, else the structured proxy type. */
  kind: 'url' | 'http' | 'https' | 'socks5';
  /** Display-safe `host:port` (parsed from a url form; userinfo stripped). */
  endpoint?: string;
  /** Optional non-secret username (for display); the password is never returned. */
  username?: string;
  /** Whether a proxy password is set. The password value itself never leaves. */
  hasPassword: boolean;
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
  /**
   * Secret-free view of this account's proxy override (upstream-proxy). Absent ⇒
   * no per-account proxy configured. The password is masked to a `hasPassword`
   * flag — never returned.
   */
  proxy?: SanitizedProxyConfig;
  /**
   * Per-account model support / logical→actual remap (subscription-account-model-map)
   * — editable in the admin accounts view. Carried verbatim (secret-free — model
   * ids are not token material): an array allow-list or an object logical→actual
   * map. Absent ⇒ the account supports every model with no remap.
   */
  supportedModels?: string[] | Record<string, string>;
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
