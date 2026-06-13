/**
 * subscriptionRegistryPort — the serving-core seam for subscription dispatch
 * profile lookups used by the outbound API server.
 *
 * `routeResolver` + `subscriptionSupport` need to ask "is this provider id
 * subscription-backed, and what is its dispatch profile?". That answer lives in
 * the `SubscriptionProviderRegistry` one layer up (the subscriptions package).
 * Importing that registry UP from core is a layering inversion, so this
 * module exposes a NARROW port (`SubscriptionRegistryLike`) + a module-level
 * slot fed at bootstrap FROM that registry.
 *
 * The slot mirrors the registry's own `setSubscriptionProviderRegistry` global
 * pattern; bootstrap copies the registry into this serving-core slot once at
 * startup (correct direction). The upstream global stays alive so the existing
 * test wiring (which calls `setSubscriptionProviderRegistry`) is unchanged —
 * those tests feed the upstream global, and the bootstrap path feeds this
 * slot.
 *
 * @module outbound-api/subscriptionRegistryPort
 */

import type { SubscriptionDispatchProfile } from '../provider-proxy/types';

/**
 * The narrow surface `routeResolver` / `subscriptionSupport` use — the
 * `getProfile` lookup plus an OPTIONAL per-account OpenCodeGo config reader. A
 * `null` `getProfile` return means "unknown id; fall back to the legacy LLM
 * provider DB lookup" (same contract as the upstream registry's `getProfile`).
 */
export interface SubscriptionRegistryLike {
  getProfile(providerId: string): SubscriptionDispatchProfile | null;
  /**
   * OPTIONAL — read the currently-stored per-account OpenCodeGo config so the
   * route resolver can stamp it OPAQUELY onto `RouteContext.subscriptionConfig`
   * for the built-in `/v1/messages` plan builder.
   *
   * Core returns `unknown` ON PURPOSE: it must NEVER name the concrete
   * `OpenCodeGoTokenConfig` type from `@omnicross/subscriptions` (the cross-layer
   * litmus stays 0). The registry's concrete
   * `getOpenCodeGoConfig(): Promise<OpenCodeGoTokenConfig | undefined>` is
   * structurally ASSIGNABLE to `() => Promise<unknown>`, so the registry
   * satisfies this slot without any cast.
   *
   * Optional so BYO-only test registries / gemini-resolver-style narrow fakes
   * (which only implement `getProfile`) still satisfy the port — a missing getter
   * leaves `route.subscriptionConfig` `undefined`.
   */
  getOpenCodeGoConfig?(): Promise<unknown>;
}

let _registry: SubscriptionRegistryLike | null = null;

/**
 * Inject the subscription registry the outbound layer resolves through. Called
 * once at bootstrap with the upstream `getSubscriptionProviderRegistry()`
 * result. Idempotent — last write wins.
 */
export function setSubscriptionRegistryForOutbound(
  registry: SubscriptionRegistryLike | null,
): void {
  _registry = registry;
}

/**
 * Read the injected subscription registry, or `null` when none has been wired
 * (e.g. before bootstrap, or in unit tests that exercise only BYO routes).
 */
export function getSubscriptionRegistryForOutbound(): SubscriptionRegistryLike | null {
  return _registry;
}
