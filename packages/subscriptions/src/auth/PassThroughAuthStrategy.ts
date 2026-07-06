/**
 * PassThroughAuthStrategy — Claude OAuth subscription path.
 *
 * The proxy's pass-through code path forwards the SDK's own Authorization
 * Bearer header to api.anthropic.com verbatim. This strategy contributes:
 *   - `applyHeaders` — injects the host-managed Claude OAuth Bearer (when
 *     one exists). This is ONLY consumed by the cross-vendor route-to path
 *     (`Codex CLI → Claude subscription`, via `SubscriptionAuthSource` in the
 *     Responses ingress' `buildSubscriptionPlan`). The MAIN verbatim
 *     pass-through path (`handlePassThroughRequest`) NEVER calls `applyHeaders`
 *     — it substitutes a route-build-time-resolved Bearer onto the SDK's own
 *     forwarded header and forwards verbatim — so this stays byte-identical for
 *     the normal claude-sdk Anthropic-ingress path. When no managed token is
 *     present this is a no-op (the upstream surfaces its native 401).
 *   - `onUnauthorized` — triggers the credential store's `refreshClaudeToken()` via a
 *     shared `RefreshMutex` so the caller can re-attempt with a fresh token
 *     surfaced through `ANTHROPIC_AUTH_TOKEN` on the SDK side.
 */

import type { SubscriptionStatusEntry } from '@omnicross/contracts/subscription-types';

import type { SubscriptionCredentialStore } from '../ports/credential-store';
import { refreshSelectedAccount, resolveSelectedToken } from '../scheduler/accountSelection';
import type { SubscriptionAccountSelector } from '../scheduler/SubscriptionAccountSelector';

import type { AuthApplyHints, AuthStrategy } from './AuthStrategy';
import type { RefreshMutex } from './RefreshMutex';

export class PassThroughAuthStrategy implements AuthStrategy {
  readonly kind = 'pass-through' as const;
  readonly providerId = 'claude' as const;

  constructor(
    private readonly tokens: SubscriptionCredentialStore,
    private readonly mutex: RefreshMutex<boolean>,
    /** Shared account-pool scheduler (subscription-account-scheduling). Absent ⇒
     *  the pre-change single-account active-mirror behavior. */
    private readonly selector?: SubscriptionAccountSelector,
  ) {}

  async applyHeaders(headers: Record<string, string>, hints?: AuthApplyHints): Promise<void> {
    // The MAIN claude pass-through path (`handlePassThroughRequest`) NEVER calls
    // this — it preserves/substitutes the SDK's own Authorization header and
    // forwards verbatim, so the normal claude-sdk Anthropic-ingress flow is
    // unaffected. This method is invoked ONLY by the cross-vendor route-to path
    // (`Codex CLI → Claude subscription`, via `SubscriptionAuthSource`), where
    // there is no SDK-forwarded credential to reuse: inject the host-managed
    // Claude OAuth Bearer so the re-encoded Anthropic Messages request reaches
    // `api.anthropic.com` authenticated. When no managed token exists, leave the
    // headers untouched and let the upstream surface its native 401/403 (so the
    // SDK renders a meaningful error), matching `OAuthBearerAuthStrategy`.
    //
    // Account pool (subscription-account-scheduling): the selector picks WHICH
    // claude account serves this request; a non-active pick resolves that
    // account's token by id, otherwise the active getter runs verbatim.
    const token = await resolveSelectedToken(this.selector, this.tokens, 'claude', hints?.sessionKey, () =>
      this.tokens.getValidClaudeAccessToken(),
    );
    if (!token) return;
    headers['Authorization'] = `Bearer ${token}`;
  }

  async onUnauthorized(sessionKey?: string): Promise<boolean> {
    // Refresh the account actually served (D7); `null` ⇒ the active refresh below.
    const byId = await refreshSelectedAccount(this.selector, this.tokens, this.mutex, 'claude', sessionKey);
    if (byId !== null) return byId;
    return this.mutex.run('claude:refresh', async () => {
      try {
        return await this.tokens.refreshClaudeToken();
      } catch (err) {
        console.warn('[PassThroughAuthStrategy] Claude refresh failed:', err);
        return false;
      }
    });
  }

  async describeStatus(): Promise<SubscriptionStatusEntry> {
    const config = await this.tokens.getFullConfig();
    const claude = config.claude;
    if (!claude?.accessToken) {
      return { providerId: 'claude', ok: false, reason: 'missing-credential' };
    }
    if (claude.status === 'expired') {
      return {
        providerId: 'claude',
        ok: false,
        reason: claude.refreshToken ? 'expired' : 'reauth-required',
        expiresAt: claude.expiresAt,
      };
    }
    return { providerId: 'claude', ok: true, expiresAt: claude.expiresAt };
  }
}
