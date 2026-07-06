/**
 * AuthSource — unified outbound-authentication strategy for the provider
 * request pipeline.
 *
 * Phase 2 of the `provider-request-pipeline` OpenSpec change (design D3).
 *
 * The three consumer paths (the wire-format proxy handler, the host engine
 * adapter, TransformerHandler) each authenticate differently:
 *
 *   - provider-key (+ ApiKeyPool failover)  — LLM-config provider rows
 *   - subscription `AuthStrategy` (+ 401 refresh + fallback) — code-cli OAuth
 *   - OAuth pass-through                     — SDK forwards its own Bearer
 *
 * `AuthSource` is the single contract that unifies these. THIS PHASE ONLY
 * DEFINES the interface and provides three behavior-preserving WRAPPERS
 * (`LlmConfigProviderAuth`, `SubscriptionAuthSource`, `OAuthPassThroughAuth`)
 * around the existing logic. NO caller is routed through it yet — the core
 * (`executeProviderCall`) is NOT changed to consume `ctx.auth`, and
 * the host handler's branch structure is UNCHANGED. Wiring (and
 * the `onResult` pool-rotation integration) is Phase 3.
 *
 * @module pipeline/AuthSource
 */

/**
 * Hints an `AuthSource` may need to vary header formatting per request.
 *
 * Mirrors the subscription-side `AuthApplyHints` (which uses optional
 * `upstreamUrl` / `resolvedModel`) but with REQUIRED fields, since the
 * pipeline always knows both at the point it applies headers. Adapters that
 * wrap the looser subscription shape map these across at the boundary.
 */
export interface AuthApplyHints {
  /** Resolved upstream URL the request will be sent to. */
  upstreamUrl: string;
  /** Resolved model id for the request. */
  model: string;
  /**
   * OPTIONAL stable per-conversation session key (subscription-account-scheduling,
   * D5) — mapped through to the subscription strategy's sticky account affinity.
   * BYO auth sources ignore it.
   */
  sessionKey?: string;
}

/**
 * Result of {@link AuthSource.onResult}.
 *
 * `rebound` is `true` when the auth source rotated to a different credential
 * (e.g. ApiKeyPool re-bound the session to a new key after a 429). `newKey`
 * carries the freshly-resolved key string when a rotation produced one, so a
 * caller MAY retry the same call once with it. Mirrors the
 * `{ newKey | null }` contract of `ApiKeyPoolService.reportError` lifted into
 * a structured shape.
 */
export interface AuthResultOutcome {
  /** Whether the credential was rotated/re-bound as a result of this status. */
  rebound: boolean;
  /** The new resolved key when a rotation produced one; omitted otherwise. */
  newKey?: string;
}

/**
 * A pluggable outbound-authentication source for one provider request.
 *
 * Implementations OWN exactly the auth concern: which headers carry the
 * credential, how to recover from a 401, where the request should be sent
 * (when the credential dictates the endpoint), and how to react to a final
 * HTTP status (pool rotation / refresh). The pipeline core composes the rest.
 */
export interface AuthSource {
  /**
   * Inject the authentication headers for this request, mutating `headers`
   * in place. Implementations MAY refresh expiring tokens here.
   *
   * NOTE (Phase 2 boundary, see report): exactly WHAT this owns vs what the
   * ingress assembles (content-type, OpenRouter app headers, proxy auth
   * stripping) is intentionally left to the caller this phase. The wrappers
   * preserve their source's CURRENT header behavior verbatim.
   */
  applyHeaders(headers: Record<string, string>, hints: AuthApplyHints): Promise<void> | void;

  /**
   * Called when the upstream returns 401. Return `true` to ask the caller to
   * retry once with freshly-applied headers; `false` to surface the 401.
   * Optional — sources without a refresh notion omit it.
   *
   * The OPTIONAL `sessionKey` (subscription-account-scheduling, D7) lets a
   * subscription source refresh the account the request was actually served by;
   * BYO sources ignore it.
   */
  onUnauthorized?(sessionKey?: string): Promise<boolean>;

  /**
   * Resolve the upstream URL the request should target, when the credential
   * dictates it (e.g. a subscription profile's per-model endpoint). Returns
   * `undefined` when the source does not override the URL (the ingress keeps
   * its own URL logic). Optional.
   */
  resolveUpstreamUrl?(model: string): string | undefined;

  /**
   * React to a final HTTP status (pool participation seam — design D5).
   *
   * For the provider-key source this reports the status to the
   * `ApiKeyPoolService` (cooldown / disable / re-bind) and returns whether it
   * rotated plus any new key. THIS PHASE ONLY: `onResult` is implemented and
   * unit-tested in isolation; NO caller invokes it yet. Phase 3 wires it into
   * `fetchWithRetry`. Optional.
   *
   * @param status The final HTTP status, or `null` for non-HTTP failures
   *   (e.g. network errors). Non-reportable statuses no-op.
   */
  onResult?(status: number | null): Promise<AuthResultOutcome>;
}
