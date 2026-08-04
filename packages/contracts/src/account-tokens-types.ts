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
 *  - `{ url }`      a full proxy URL, e.g. `http://user:pass@host:1080` or
 *                     `socks5://host:1080` (userinfo carries basic-auth).
 *  - structured     an explicit `{ type, host, port, username, password }`.
 *
 * `username`/`password` are SECRETS: encrypted at rest via the same envelope as
 * other credentials, masked in every sanitized/admin view, and never logged
 * (logs carry at most `host:port`). Additive everywhere it appears absent a
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
 * Persisted per-account client identity (subscription-client-fingerprint #7, P2).
 * The frozen fingerprint headers a real Claude Code client sent for this account,
 * captured + replayed so relayed traffic presents a stable identity across
 * restarts. NON-secret metadata: it holds ONLY whitelisted fingerprint headers
 * (`x-stainless-*` / user-agent / anthropic-beta / x-app / CC headers) NEVER
 * `authorization` / `x-api-key` / `cookie` (excluded at capture AND at
 * store-normalize). Additive + OPTIONAL an existing `tokens.json` without it
 * parses unchanged (the account re-captures from a real client). Because it is
 * non-secret it lives on the entry OUTSIDE the encrypted `tokens` block and is
 * not walked by the secrets encryptor.
 */
export type AccountClientIdentity = {
  /** The frozen fingerprint headers (lowercased keys; token/secret excluded). */
  headers: Record<string, string>;
  /** Epoch ms of the freeze / last TTL refresh. */
  capturedAt: number;
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
 * Machine-readable managed-account credential warning code.
 *
 * `duplicate-token` means two managed accounts of one provider share the same
 * credential. Native CLI credential files are not compared by normal account
 * listing or refresh paths.
 */
export type SyncWarningCode = 'duplicate-token';

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
  /** Managed-account credential warning; duplicate-token may be projected on
   *  account listing. */
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
  /** Managed-account credential warning; duplicate-token may be projected on
   *  account listing. */
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
  /** User-supplied label; default "N" / "Account N". */
  label?: string;
  /** Whether the scheduler may select this account. Absent on legacy rows means true. */
  enabled?: boolean;
  /** Operator-defined account-pool group. Absent rows are presented in their provider group. */
  group?: string;
  /** Searchable operator metadata. Tags are non-secret and normalized on write. */
  tags?: string[];
  /** ISO creation timestamp. */
  createdAt?: string;
  /**
   * Scheduling precedence in the account pool (subscription-account-scheduling).
   * Lower = higher precedence; default `50` when absent. OPTIONAL: an existing
   * `tokens.json` without it parses unchanged and
   * every account defaults to 50.
   */
  priority?: number;
  /**
   * ISO timestamp of the last time this account was selected to serve a request
   * (subscription-account-scheduling LRU tie-break input). OPTIONAL, best-effort
   * throttled persist the selector's in-memory overlay is the authoritative live
   * value; an account without it sorts as least-recently-used (timestamp `0`).
   */
  lastUsedAt?: string;
  /**
   * Per-account upstream proxy override (upstream-proxy). When set, this
   * account's relay + OAuth-refresh traffic is routed through this proxy,
   * WINNING over the per-provider and global proxy layers. OPTIONAL an
   * existing `tokens.json` without it parses unchanged (no proxy direct). Its
   * `password` is a secret: encrypted at rest by the tokens `SecretBox` walker
   * and masked in the sanitized view.
   */
  proxy?: ProxyConfig;
  /**
   * Per-account model support + logicaltual remap (subscription-account-model-map).
   * Supports both allow-list and logical-to-actual mapping formats. OPTIONAL: an existing `tokens.json` without it parses
   * unchanged (the account supports every model and never remaps, byte-identical
   * to before this change):
   *  - **array** `["a","b"]` an ALLOW-LIST: the account supports ONLY these
   *    logical models (skip-only, no remap). In a -account pool the account is
   *    routed AROUND for any other model.
   *  - **object** `{ "a": "X", "b": "Y" }` the keys are the same allow-list AND
   *    each value is the account's ACTUAL upstream model, so a selected account
   *    remaps the logical model to its actual model on the outbound request.
   *
   * Model-support filtering only applies when the provider has  accounts (the
   * same gate as account health) a sole account is never model-gated
   * (never-strand; the upstream stays authoritative). A sole account that must
   * serve a logical model AS a different actual model uses the OBJECT map (remap),
   * not skip.
   */
  supportedModels?: string[] | Record<string, string>;
  /**
   * Persisted per-account client fingerprint identity (subscription-client-
   * fingerprint #7, P2). OPTIONAL, additive, NON-secret metadata (kept OUTSIDE the
   * encrypted `tokens` block) an existing `tokens.json` without it parses
   * unchanged. Written through by the daemon on a first-seen freeze / TTL refresh;
   * seeded back into the in-memory identity store at boot so a claude account's
   * replayed identity survives restart.
   */
  identity?: AccountClientIdentity;
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
 * password is NEVER carried only a `hasPassword` presence flag plus a
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
  /** Explicit scheduling switch. Legacy rows are projected as enabled. */
  enabled: boolean;
  /** Effective group (provider id when the persisted group is absent). */
  group: string;
  /** Searchable non-secret operator tags. */
  tags: string[];
  status: TokenStatus;
  authMethod?: string;
  subscriptionLevel?: string;
  expiresAt?: string;
  lastRefreshedAt?: string;
  isSetupToken?: boolean;
  hasAccessToken: boolean;
  isActive: boolean;
  /** Derived current eligibility after operator, live-health, and allowance gates. */
  schedulable: boolean;
  /** Read-only allowance policy projection. Absent on older daemons. */
  allowanceAction?: 'normal' | 'demote' | 'pause' | 'ignore';
  /** Priority after the allowance policy's optional demotion penalty. */
  allowanceEffectivePriority?: number;
  /** Highest fresh allowance-window consumption used for this decision. */
  allowanceUsedPercent?: number;
  /** Known reset/deadline associated with the allowance decision. */
  allowanceResumeAt?: string;
  /** Redacted and bounded credential diagnostic, when the provider recorded one. */
  errorMessage?: string;
  /**
   * Scheduling precedence (subscription-account-scheduling) editable in the
   * admin accounts view so an operator can order a pool. Absent default 50.
   */
  priority?: number;
  /**
   * ISO timestamp of the last scheduler selection (display-only in the admin
   * accounts view). Absent never selected (or the best-effort persist has not
   * yet flushed).
   */
  lastUsedAt?: string;
  /**
   * Managed-account credential warning. The daemon retains duplicate-token
   * warnings without consulting native CLI credential files.
   */
  syncWarning?: SyncWarningCode;
  /**
   * Live scheduling-health state (subscription-account-health) in-memory, never
   * persisted. Absent / `'healthy'` eligible; the rest mean the account is
   * currently excluded from the pool (multi-account) or would surface the
   * upstream's error (single-account). Secret-free.
   */
  health?: 'healthy' | 'rate_limited' | 'overloaded' | 'transient' | 'blocked';
  /**
   * ISO instant the current health cooldown elapses (absent for healthy /
   * permanently-blocked). Lets the admin view render "rate-limited until .
   */
  cooldownUntil?: string;
  /**
   * Secret-free view of this account's proxy override (upstream-proxy). Absent    * no per-account proxy configured. The password is masked to a `hasPassword`
   * flag never returned.
   */
  proxy?: SanitizedProxyConfig;
  /**
   * Per-account model support / logicaltual remap (subscription-account-model-map)
   * editable in the admin accounts view. Carried verbatim (secret-free model
   * ids are not token material): an array allow-list or an object logicaltual
   * map. Absent the account supports every model with no remap.
   */
  supportedModels?: string[] | Record<string, string>;
  /**
   * COARSE client-fingerprint status (subscription-client-fingerprint #7, D7)    * whether THIS account has a captured/frozen client identity in the in-memory
   * store. Present only when fingerprint replay is ENABLED (else absent the UI
   * shows nothing). Secret-free by construction: it is a BOOLEAN only the raw
   * captured headers are NEVER surfaced here (nor in any admin view).
   */
  identityCaptured?: boolean;
  /**
   * ISO instant this account's fingerprint identity was frozen / last TTL-refreshed
   * (subscription-client-fingerprint #7, D7). Present only alongside
   * `identityCaptured === true`. Coarse timestamp only never the headers.
   */
  identityCapturedAt?: string;
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
