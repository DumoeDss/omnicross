/**
 * SubscriptionAuthStrategy — the pluggable subscription-auth contract, defined
 * in the serving core (`pipeline/`).
 *
 * Each subscription provider in the `SubscriptionProviderRegistry` (the
 * subscriptions package) carries an `AuthStrategy` instance. The proxy calls
 * `applyHeaders` before issuing the upstream request and `onUnauthorized`
 * after a 401 to ask whether to retry.
 *
 * It is a PURE contract (no upstream semantics), defined down here so
 * `pipeline/SubscriptionAuthSource.ts` consumes it WITHOUT importing upward
 * (correct dependency direction). The subscriptions package's
 * `auth/AuthStrategy.ts` RE-EXPORTS this type, and its three concrete
 * strategies implement THIS interface — so they remain assignable and no
 * downstream consumer's import path changes.
 *
 * NOTE: this `AuthApplyHints` (OPTIONAL fields) is the SUBSCRIPTION-side hint
 * shape and is intentionally distinct from `pipeline/AuthSource.ts`'s
 * `AuthApplyHints` (REQUIRED fields). They are not interchangeable; the
 * `SubscriptionAuthSource` adapter maps between them at the boundary.
 *
 * @module pipeline/SubscriptionAuthStrategy
 */

import type { SubscriptionProviderId, SubscriptionStatusEntry } from '@omnicross/contracts/subscription-types';

/** Hints the strategy may need to vary header formatting per request. */
export interface AuthApplyHints {
  /** Resolved upstream URL — used by some strategies (e.g. OpenCodeGo) to
   *  choose between Anthropic-shape and OpenAI-shape headers. */
  upstreamUrl?: string;
  /** Resolved model id — same purpose as `upstreamUrl`. */
  resolvedModel?: string;
}

export interface AuthStrategy {
  /** Discriminator — also surfaced through `subscription:list` to renderers. */
  readonly kind: 'pass-through' | 'oauth-bearer' | 'static-bearer';
  /** Stable id of the bound subscription provider. */
  readonly providerId: SubscriptionProviderId;

  /**
   * Inject any required authentication headers into the outbound request.
   * Implementations MAY refresh expiring tokens here (transparent refresh).
   *
   * Pass-through implementations are a no-op; the proxy's pass-through
   * code path preserves the SDK's own Authorization header instead.
   */
  applyHeaders(headers: Record<string, string>, hints?: AuthApplyHints): Promise<void>;

  /**
   * Called when the upstream returns 401. Return `true` to ask the proxy to
   * retry the request once with freshly-applied headers; return `false` to
   * surface the 401 immediately.
   *
   * Implementations SHOULD use a shared `RefreshMutex` to dedupe concurrent
   * refreshes so N parallel 401s collapse into one upstream refresh call.
   */
  onUnauthorized(): Promise<boolean>;

  /** Diagnostic surface for the `subscription:status` IPC. */
  describeStatus(): Promise<SubscriptionStatusEntry>;
}
