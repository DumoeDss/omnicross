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

/** The six methods the subscription block consumes from the host credential store. */
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
}
