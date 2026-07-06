/**
 * SubscriptionCredentialStore — the credential port the subscription block
 * depends on instead of the host's concrete token store.
 *
 * The subscription auth strategies + account service + provider registry only
 * ever consume a narrow six-method surface of the host's encrypted OAuth/static
 * credential store. Declaring it here (in `@omnicross/subscriptions`) keeps the
 * package host-clean: the host injects its concrete token store (which
 * structurally satisfies this interface) at bootstrap.
 *
 * The serving core (`@omnicross/core`) does NOT consume credentials — it sees
 * the subscription registry only through the `subscriptionRegistryPort` slot —
 * so this port lives in THIS package, not in core (Phase-0b port pattern at the
 * subscriptions layer).
 */

import type { AccountTokensConfig } from '@omnicross/contracts/account-tokens-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';

/**
 * The credential surface the subscription block consumes from the host store.
 *
 * The six ORIGINAL methods (active-account getters + refreshers) are REQUIRED;
 * the three by-id methods (subscription-account-scheduling, design D6) are
 * OPTIONAL and feature-detected so every existing lightweight test double that
 * implements only the six keeps compiling and the single-account active path is
 * untouched.
 */
export interface SubscriptionCredentialStore {
  /** Full decrypted account-tokens config (all subscription providers). */
  getFullConfig(): Promise<AccountTokensConfig>;
  /** Current valid Claude OAuth access token, refreshing if near expiry; `null` if none. */
  getValidClaudeAccessToken(): Promise<string | null>;
  /** Force a Claude OAuth token refresh; `true` on success. */
  refreshClaudeToken(): Promise<boolean>;
  /** Force a Codex (ChatGPT) OAuth token refresh; `true` on success. */
  refreshCodexToken(): Promise<boolean>;
  /** Force a Gemini (Google) OAuth token refresh; `true` on success. */
  refreshGeminiToken(): Promise<boolean>;
  /** Current valid OpenCodeGo static API key; `null` if none. */
  getValidOpenCodeGoApiKey(): Promise<string | null>;

  // ── By-id account-pool surface (subscription-account-scheduling, OPTIONAL) ──

  /**
   * Resolve a SPECIFIC account's access token by id (refreshing a near-expiry
   * OAuth token for that account, mirroring the active getter's per-provider
   * refresh policy). `null` when the account is unknown/expired/tokenless.
   */
  getAccessTokenForAccount?(providerId: SubscriptionProviderId, accountId: string): Promise<string | null>;
  /**
   * Force a refresh of a SPECIFIC account's OAuth token by id; `true` on success.
   * Static-key providers (opencodego) return `false` — they don't refresh.
   */
  refreshAccountToken?(providerId: SubscriptionProviderId, accountId: string): Promise<boolean>;
  /**
   * Best-effort record of a selection's time onto the account's `lastUsedAt`
   * (throttled by the selector so the hot path does not rewrite the store every
   * request). Durability only — never affects which credential is valid.
   */
  touchAccountLastUsed?(providerId: SubscriptionProviderId, accountId: string, iso: string): Promise<void>;
}
