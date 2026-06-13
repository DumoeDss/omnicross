/**
 * OAuthPassThroughAuth — `AuthSource` for the OAuth pass-through path.
 *
 * The Claude pass-through proxy branch forwards the Claude Agent SDK's OWN
 * `Authorization: Bearer` header to `api.anthropic.com` verbatim — the host must
 * NOT replace or add an auth header on this path. This source therefore makes
 * `applyHeaders` a NO-OP, preserving whatever bearer the SDK already set.
 *
 * It mirrors the contribution of `PassThroughAuthStrategy.applyHeaders` (also a
 * no-op). `onUnauthorized` is intentionally NOT implemented here: in the
 * pass-through flow the 401 refresh lands in the host's token store and is
 * re-read by the SDK via `ANTHROPIC_AUTH_TOKEN` at the next request, not by
 * mutating the in-flight request headers. A caller that needs the refresh notion
 * should use `SubscriptionAuthSource` over the Claude `PassThroughAuthStrategy`
 * instead.
 */

import type { AuthApplyHints, AuthSource } from './AuthSource';

export class OAuthPassThroughAuth implements AuthSource {
  /**
   * No-op. The pass-through branch preserves the SDK's own Authorization
   * header, so this source never adds or replaces auth headers.
   */
  applyHeaders(_headers: Record<string, string>, _hints: AuthApplyHints): void {
    // intentionally empty — preserves the SDK-supplied bearer
  }
}
