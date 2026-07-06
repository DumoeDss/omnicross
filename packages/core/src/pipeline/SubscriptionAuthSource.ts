/**
 * SubscriptionAuthSource — `AuthSource` wrapping a subscription `AuthStrategy`.
 *
 * Phase 2 of the `provider-request-pipeline` OpenSpec change (design D3, task 4.3).
 *
 * Re-expresses the subscription auth used by `SubscriptionDispatcher` behind
 * the unified `AuthSource` contract, delegating to the existing
 * `AuthStrategy` so the OAuth refresh / token formatting logic is NOT
 * rewritten:
 *
 *   - `applyHeaders` → `stripAuthHeaders(headers)` then
 *     `authStrategy.applyHeaders(headers, { upstreamUrl, resolvedModel })`,
 *     wrapped in the same best-effort try/catch as
 *     `SubscriptionDispatcher.applyHeadersWithRetry` (a thrown
 *     `applyHeaders` is logged + swallowed, NOT propagated — preserved
 *     verbatim).
 *   - `onUnauthorized` → `authStrategy.onUnauthorized()`.
 *   - `resolveUpstreamUrl` → `profile.resolveUpstreamUrl?.(model)`.
 *
 * IMPORTANT (Phase 2 scope): this WRAPS the strategy + strip behavior but does
 * NOT re-route `SubscriptionDispatcher` through it. The dispatcher's fragile
 * 401-refresh + fallback loop is left UNCHANGED (task 4.5 deferred). This
 * class is unit-tested in isolation only.
 *
 * @module pipeline/SubscriptionAuthSource
 */

import type {
  OpenCodeGoModelEntry,
  OpenCodeGoScenario,
  OpenCodeGoTokenConfig,
} from '@omnicross/contracts/subscription-types';
import { serializeError } from '@omnicross/core/serializeError';

import type { AuthApplyHints, AuthSource } from './AuthSource';
import type { AuthStrategy } from './SubscriptionAuthStrategy';

/**
 * Lightweight summary derived from the inbound request body — consumed by a
 * profile's `modelMapper` (scenario routing). Structural mirror of
 * `provider-proxy/types.ts`'s `SubscriptionRequestSummary`, declared here so
 * `SubscriptionAuthProfile.modelMapper` is type-identical WITHOUT a circular
 * import back into `provider-proxy/types` (which imports THIS module).
 */
export interface SubscriptionRequestSummary {
  messageCount: number;
  estimatedInputTokens: number;
  /**
   * OPTIONAL bounded per-message match-text slice — kept structurally identical
   * to the canonical declaration in `provider-proxy/types.ts` (the two are
   * deliberate mirrors, not one shared import). Consumed only by the OpenCodeGo
   * keyword matcher in `@omnicross/subscriptions`; core writes, never reads it.
   */
  matchText?: string[];
}

/**
 * The subset of a `SubscriptionDispatchProfile` the subscription paths need.
 * Kept structural (not the full profile type) so the wrapper does not pull in
 * the whole registry surface. The full `SubscriptionDispatchProfile` (which IS
 * what gets passed here) satisfies this shape; the optional `mode` + `modelMapper`
 * are read by the built-in `/v1/messages` subscription path (RT2.1) to decide the
 * verbatim-vs-transformer shape and to apply opencodego scenario routing.
 */
export interface SubscriptionAuthProfile {
  readonly authStrategy: AuthStrategy;
  /** Per-model upstream URL resolver (transformer profiles). Optional for
   *  pass-through profiles that hard-code their endpoint upstream. The OPTIONAL
   *  2nd `config` arg (opencodego `baseUrl` override, D1) is additive — existing
   *  one-arg callers compile unchanged; mirrors the full
   *  `SubscriptionDispatchProfile.resolveUpstreamUrl` so the registry profile
   *  stays assignable. */
  readonly resolveUpstreamUrl?: (
    resolvedModel: string,
    config?: OpenCodeGoTokenConfig,
  ) => string;
  /**
   * Names of provider-level transformers (registered in `TransformerService`)
   * to run on the subscription chain — re-encode Unified → the upstream's wire.
   * The full `SubscriptionDispatchProfile` (which IS what gets passed here)
   * carries these; exposing them on the narrow structural type lets the
   * Responses ingress build the profile's REAL chain (cross-vendor route-to,
   * task #29) instead of hard-coding `['openai-response']`. Absent/empty →
   * the ingress falls back to its endpoint transformer (codex byte-identity).
   */
  readonly providerTransformerNames?: readonly string[];
  /** Names of model-specific transformers — usually empty. See above. */
  readonly modelTransformerNames?: readonly string[];
  /**
   * OPTIONAL shape-aware provider transformer-name resolver (opencodego zen).
   * Type-identical to `SubscriptionDispatchProfile.resolveProviderTransformerNames`
   * so the registry profile stays assignable. The built-in `/v1/messages`
   * subscription path (Phase 3) consults it via
   * `profile.resolveProviderTransformerNames?.(model, route.subscriptionConfig)`
   * to pick the right zen chain per resolved shape. `config` is `unknown` (core
   * opaque-config discipline — no `@omnicross/subscriptions` import). When ABSENT
   * the path reads the static `providerTransformerNames` exactly as today (codex
   * byte-identity).
   */
  readonly resolveProviderTransformerNames?: (
    model: string,
    config?: unknown,
  ) => readonly string[];
  /**
   * Pass-through (claude) vs transformer (codex / opencodego / gemini). The
   * built-in `/v1/messages` subscription path (RT2.1) reads this for its
   * core-local same-format signal (pass-through ⇒ always verbatim relay).
   * Optional on the narrow type — partial profiles built by other route-minting
   * sites may omit it.
   */
  readonly mode?: 'pass-through' | 'transformer';
  /**
   * Optional model placeholder rewriter — only set for OpenCodeGo. Type-identical
   * to `SubscriptionDispatchProfile.modelMapper` so the registry profile stays
   * assignable. Applied by the built-in `/v1/messages` subscription path BEFORE
   * resolving the upstream URL (so scenario-based shape routing picks the right
   * Anthropic-shape vs OpenAI-shape upstream).
   */
  readonly modelMapper?: (
    sdkModel: string,
    summary: SubscriptionRequestSummary,
    config: OpenCodeGoTokenConfig | undefined,
  ) => { resolvedModel: string; scenario: OpenCodeGoScenario };
  /**
   * Optional fallback resolver — only set for OpenCodeGo. Type-identical to
   * `SubscriptionDispatchProfile.nextFallback` so the registry profile stays
   * assignable. Read by the built-in `/v1/messages` fallback loop (D6b) to pick
   * the next model after an unrecoverable upstream failure; returns `null` when
   * exhausted (claude / codex / gemini omit it → no fallback attempted).
   */
  readonly nextFallback?: (
    scenario: OpenCodeGoScenario,
    attempted: readonly string[],
    config: OpenCodeGoTokenConfig | undefined,
  ) => OpenCodeGoModelEntry | null;
  /**
   * Optional circuit-breaker admission gate for the PRIMARY (mapped) model (D5
   * primary-gating). Type-identical to `SubscriptionDispatchProfile.allowModel`.
   * Only OpenCodeGo sets it; the core `/v1/messages` loop consults it for the
   * primary before its first attempt and jumps to the first admitting
   * `nextFallback` candidate when the primary's circuit is open. Absent ⇒ the
   * primary is always admitted (claude / codex / gemini — no breaker).
   */
  readonly allowModel?: (modelId: string) => boolean;
  /**
   * Optional record-outcome callback (D5 record seam). Type-identical to
   * `SubscriptionDispatchProfile.recordModelOutcome`. The core `/v1/messages`
   * loop calls `profile.recordModelOutcome?.(model, ok)` THROUGH this optional
   * field after each attempt, so `@omnicross/core` gains NO import of
   * `@omnicross/subscriptions` (the cross-layer litmus stays 0 — exactly the
   * `nextFallback` precedent). `ok: true` on `2xx`; `ok: false` on
   * thrown/`5xx`/`429`; a non-429 `4xx` is NEUTRAL (the loop does NOT call it).
   * Absent for claude / codex / gemini ⇒ no-op.
   */
  readonly recordModelOutcome?: (modelId: string, ok: boolean) => void;
}

/**
 * Drop auth headers the transformer chain may have set so the `AuthStrategy`
 * is the single source of truth for outbound authentication. Byte-identical
 * to `SubscriptionDispatcher.stripAuthHeaders`.
 */
export function stripAuthHeaders(headers: Record<string, string>): void {
  delete headers.authorization;
  delete headers.Authorization;
  delete headers['x-api-key'];
  delete headers['X-Api-Key'];
  delete headers['x-goog-api-key'];
  delete headers['X-Goog-Api-Key'];
}

export class SubscriptionAuthSource implements AuthSource {
  constructor(private readonly profile: SubscriptionAuthProfile) {}

  /**
   * Strip any transformer-set auth headers, then delegate to the bound
   * strategy. Mirrors `SubscriptionDispatcher`'s
   * `stripAuthHeaders(...)` + `applyHeadersWithRetry(...)` sequence, including
   * the best-effort swallow-and-warn around a throwing `applyHeaders`.
   *
   * The strategy's looser `AuthApplyHints` (optional `upstreamUrl` /
   * `resolvedModel`) is fed from the pipeline's required `{ upstreamUrl,
   * model }` at the boundary.
   */
  async applyHeaders(headers: Record<string, string>, hints: AuthApplyHints): Promise<void> {
    stripAuthHeaders(headers);
    try {
      await this.profile.authStrategy.applyHeaders(headers, {
        upstreamUrl: hints.upstreamUrl,
        resolvedModel: hints.model,
        sessionKey: hints.sessionKey,
      });
    } catch (err) {
      console.warn('[SubscriptionAuthSource] authStrategy.applyHeaders threw:', serializeError(err));
    }
  }

  /** Delegate the 401-refresh decision to the bound strategy, threading the
   *  session key so the account actually served is the one refreshed (D7). */
  async onUnauthorized(sessionKey?: string): Promise<boolean> {
    return this.profile.authStrategy.onUnauthorized(sessionKey);
  }

  /** Resolve the upstream URL from the profile, when it provides one. */
  resolveUpstreamUrl(model: string): string | undefined {
    return this.profile.resolveUpstreamUrl?.(model);
  }
}
