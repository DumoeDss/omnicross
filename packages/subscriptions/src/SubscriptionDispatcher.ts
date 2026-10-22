/**
 * SubscriptionDispatcher — handles the dispatch proxy's subscription-mode flow.
 *
 * Extracted from the host proxy server to keep that file focused on the legacy
 * LLM-provider pipeline. The dispatcher mirrors the proxy's inner
 * transformer-pipeline shape but sources upstream URL,
 * transformer chain, auth, and model mapping from a
 * `SubscriptionDispatchProfile` instead of the host's config service.
 *
 * The proxy delegates here from `handleRequest` whenever a profile is bound.
 */

import type http from 'node:http';

import type { OpenCodeGoModelEntry, OpenCodeGoScenario, OpenCodeGoTokenConfig } from '@omnicross/contracts/subscription-types';
import { isAccountAllowanceExhaustedError } from '@omnicross/core/pipeline/AccountAllowanceScheduling';
import { isBoundAccountSelectionError } from '@omnicross/core/pipeline/BoundAccountSelectionError';
import { getAntigravityProjectResolver } from '@omnicross/core/auth/GeminiCodeAssistProjectResolver';
import { getGeminiCodeAssistResolver } from '@omnicross/core/ports/gemini-code-assist-resolver';
import {
  getSharedAccountHealth,
  type HeadersLike,
  resolveResetSeconds,
} from '@omnicross/core/pipeline/SubscriptionAccountHealth';
import { collectMatchText, deriveSubscriptionSessionKey } from '@omnicross/core/provider-proxy/matchText';
import { serializeError } from '@omnicross/core/serializeError';
import { maybeAntigravityFailoverUrl } from '@omnicross/core/transformer/transformers/antigravityFailover';
import type { TransformerChainExecutor } from '@omnicross/core/transformer/TransformerChainExecutor';
import type { TransformerService } from '@omnicross/core/transformer/TransformerService';
import type {
  LLMProvider as TransformerLLMProvider,
  Transformer,
  TransformRequestResult,
  UnifiedChatRequest,
} from '@omnicross/core/transformer/types';
import type { AuthApplyHints } from './auth/AuthStrategy';

import {
  resolveOpenCodeGoHalf,
  resolveOpenCodeGoShape,
} from './opencodego/model-shape';
import { estimateTokensCachedSync } from './opencodego/token-count';
import type {
  SubscriptionDispatchProfile,
  SubscriptionRequestSummary,
} from './SubscriptionProviderRegistry';

/** Hooks the dispatcher needs from the host proxy server's private surface. */
export interface DispatcherHooks {
  /** Anthropic endpoint transformer instance, reused across requests. */
  readonly endpointTransformer: Transformer;
  /** Shared transformer chain executor. */
  readonly executor: TransformerChainExecutor;
  /** Shared transformer service registry — looks up transformer-by-name. */
  readonly transformerService: TransformerService;
  /**
   * Fetch + retry helper from the proxy (semaphore, 429/5xx loop). On a non-ok
   * upstream it throws a `ProviderApiError`-shaped error carrying `.status`.
   *
   * ACCOUNT-HEALTH CONTRACT (subscription-account-health): for the daemon-path
   * 429-reset cooldown + 403-ban sniff to function, the thrown error SHOULD also
   * carry the upstream response `headers` (a `Headers` or a plain record) and, on
   * a 403, a bounded `bodyText`/`body` string. The dispatcher reads them
   * STRUCTURALLY (`errHeaders`/`errBodyText`) — absent ⇒ the account-health mark
   * gracefully degrades to a bare-429 (unmarked, lazy re-probe), never an error.
   */
  fetchWithRetry(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    model: string,
  ): Promise<Response>;
  /** Forward the upstream response to the SDK + tap usage. */
  writeProxyResponse(
    res: http.ServerResponse,
    providerResponse: Response,
    isStream: boolean,
    reqId?: number,
  ): Promise<void>;
}

export interface DispatchRequest {
  reqId: number;
  res: http.ServerResponse;
  rawBody: string;
  anthropicBody: Record<string, unknown>;
  isStream: boolean;
  sdkModel: string;
  fallbackModel: string;
}

export class SubscriptionDispatcher {
  constructor(
    private readonly profile: SubscriptionDispatchProfile,
    private readonly hooks: DispatcherHooks,
    private readonly getOpenCodeGoConfig: () => Promise<OpenCodeGoTokenConfig | undefined>,
  ) {}

  /**
   * Entry point — called by the host proxy's request handler after model
   * resolution and probe-detection.
   */
  async dispatch(req: DispatchRequest): Promise<void> {
    // Account-pool session key (subscription-account-scheduling, D5) — derived once
    // from the stable request anchor, threaded into every auth apply + 401 retry so
    // a conversation sticks to one pooled account.
    const sessionKey = deriveSubscriptionSessionKey(req.anthropicBody);

    // 1. Resolve the model via the profile's mapper (OpenCodeGo scenario
    //    routing). For other profiles the mapper is undefined and we keep
    //    the SDK-resolved model as-is.
    const ocConfig = this.profile.providerId === 'opencodego'
      ? await this.getOpenCodeGoConfig()
      : undefined;

    let scenario: OpenCodeGoScenario = 'default';
    let resolvedModel = req.fallbackModel;
    let modelDefaults: Pick<OpenCodeGoModelEntry, 'temperature' | 'maxTokens'> = {};
    if (this.profile.modelMapper) {
      const summary = this.buildRequestSummary(req.anthropicBody);
      const mapped = this.profile.modelMapper(req.sdkModel, summary, ocConfig);
      resolvedModel = mapped.resolvedModel;
      scenario = mapped.scenario;
      modelDefaults = mapped;
      req.anthropicBody.model = resolvedModel;
    }

    // 2. Decide upstream URL + shape (per-model for OpenCodeGo). Pass the
    //    already-fetched `ocConfig` so the opencodego profile honors a per-account
    //    `baseUrl` override (D1). `ocConfig` is `undefined` for non-opencodego
    //    profiles, leaving their URL byte-identical.
    const upstreamUrl = this.profile.resolveUpstreamUrl?.(resolvedModel, ocConfig);
    if (!upstreamUrl) {
      throw new Error(`[SubscriptionDispatcher] profile=${this.profile.providerId} missing resolveUpstreamUrl`);
    }

    await this.dispatchTransformerChain(req, upstreamUrl, resolvedModel, scenario, ocConfig, sessionKey, modelDefaults);
  }

  /** Dispatch each attempt using the resolved model's native wire. */
  private async dispatchTransformerChain(
    req: DispatchRequest,
    upstreamUrl: string,
    resolvedModel: string,
    scenario: OpenCodeGoScenario,
    ocConfig: OpenCodeGoTokenConfig | undefined,
    sessionKey: string | undefined,
    modelDefaults: Pick<OpenCodeGoModelEntry, 'temperature' | 'maxTokens'>,
  ): Promise<void> {
    const modelTransformers = this.resolveTransformers(this.profile.modelTransformerNames);

    const transformerProvider: TransformerLLMProvider = {
      name: this.profile.providerId,
      baseUrl: upstreamUrl,
      apiKey: '',  // Subscription mode uses AuthStrategy; transformer auth is stripped.
      models: [resolvedModel],
      ...(this.profile.providerId === 'codex' ? { responsesDialect: 'codex' as const } : {}),
    };

    // D2 PRIMARY-GATING (D5): an open primary jumps to the first admitting
    // fallback (all-open ⇒ fail open). No-op for non-opencodego profiles (no
    // `allowModel`) → byte-identical first attempt on the mapped primary.
    const gate = this.gatePrimaryModel(resolvedModel, scenario, ocConfig);
    const attempted: string[] = gate.attempted;
    let currentModel = gate.firstModel;
    // subscription-account-health (D5): capture the effective account id.
    let usedAccountId: string | undefined;

    // Antigravity sandbox failover (design D5): one-shot latch. When the switch
    // is ON and the PRIMARY endpoint fails retryably, the SAME model is retried
    // once against the sandbox host before the error surfaces.
    let antigravityFailoverUrl: string | null = null;

    while (attempted.length < MAX_FALLBACK_ATTEMPTS_LOCAL) {
      attempted.push(currentModel);
      // Authenticate using the logical model for account eligibility, then use
      // that account's actual model for all wire selection and encoding.
      let wireModel = currentModel;
      upstreamUrl = this.profile.resolveUpstreamUrl?.(wireModel, ocConfig) ?? upstreamUrl;
      const authHeaders: Record<string, string> = {};
      const authHints: AuthApplyHints = {
        upstreamUrl,
        resolvedModel: currentModel,
        sessionKey,
        reportSelection: (accountId, _isActive, remappedModel) => {
          usedAccountId = accountId;
          wireModel = remappedModel ?? currentModel;
          upstreamUrl = this.profile.resolveUpstreamUrl?.(wireModel, ocConfig) ?? upstreamUrl;
          // Strategies inspect the target after selecting the credential.
          authHints.upstreamUrl = upstreamUrl;
        },
      };
      await this.applyHeadersWithRetry(authHeaders, authHints);
      const defaults = currentModel === resolvedModel
        ? modelDefaults
        : ocConfig?.fallbacks?.[scenario]?.find((entry) => entry.modelId === currentModel);
      const attemptBody = {
        ...req.anthropicBody,
        model: wireModel,
        ...(req.anthropicBody.temperature === undefined && defaults?.temperature !== undefined
          ? { temperature: defaults.temperature } : {}),
        ...(req.anthropicBody.max_tokens === undefined && defaults?.maxTokens !== undefined
          ? { max_tokens: defaults.maxTokens } : {}),
      };
      const providerNames =
        this.profile.resolveProviderTransformerNames?.(wireModel, ocConfig) ??
        this.profile.providerTransformerNames;
      const providerTransformers = this.resolveTransformers(providerNames);
      const bypass = this.profile.providerId === 'opencodego' &&
        resolveOpenCodeGoShape({
          provider: resolveOpenCodeGoHalf(wireModel, ocConfig),
          modelId: wireModel,
        }) === 'anthropic';
      transformerProvider.baseUrl = upstreamUrl;
      transformerProvider.models = [wireModel];

      const bearer = (authHeaders.Authorization ?? authHeaders.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
      if (this.profile.providerId === 'antigravity') {
        transformerProvider.geminiProject = bearer
          ? await getAntigravityProjectResolver().resolveProject(bearer)
          : undefined;
      } else if (this.profile.providerId === 'gemini') {
        transformerProvider.geminiProject = await this.resolveGeminiProject(bearer);
      }
      const { requestBody, config, endpointRequest }: Pick<TransformRequestResult, 'requestBody' | 'config' | 'endpointRequest'> = bypass
        ? { requestBody: attemptBody, config: {} }
        : await this.hooks.executor.executeRequestChain(
          attemptBody,
          transformerProvider,
          { providerTransformers, modelTransformers },
          { endpointTransformer: this.hooks.endpointTransformer },
        );

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(config.headers as Record<string, string> | undefined),
      };
      stripAuthHeaders(headers);
      Object.assign(headers, authHeaders);

      // Prefer the transformer-supplied URL (the gemini / gemini-code-assist
      // transformers carry the correct stream-vs-nonstream PER-MODEL colon-method
      // URL in `config.url`, built RELATIVE so the base path is preserved); fall
      // back to the profile's `resolveUpstreamUrl` value.
      //
      // EXCEPTION (the Responses chain): the `openai-response` transformer emits an
      // ABSOLUTE-path `config.url` (`new URL('/v1/responses', baseUrl)`) that
      // DISCARDS any base PATH prefix — so for a path-prefixed base (zen
      // `https://opencode.ai/zen/v1/responses` → would drop `/zen/`; codex
      // `https://chatgpt.com/backend-api/codex/responses` → would drop
      // `/backend-api/codex/`). On THIS dispatcher the endpoint transformer is
      // `anthropic` and the codex/zen-responses chain is `['openai-response']`, so
      // `shouldBypassTransformers` (which only bypasses when
      // providerTransformers[0].name === endpointTransformer.name) does NOT fire —
      // `transformRequestIn` RUNS and emits the lossy URL for BOTH codex and zen
      // responses. The guard makes this safe REGARDLESS of whether that ran:
      // `usesResponsesChain(['openai-response'])` is true for BOTH, so the profile's
      // complete `upstreamUrl` always wins (codex → its correct
      // backend-api/codex/responses; zen → its `/zen/...` endpoint). The bypass-by-
      // name optimization only applies on the core OpenAI-Responses ingress (where
      // endpoint == `openai-response`), NOT here. `// UNVERIFIED (no live zen key)`.
      const chainUrl = usesResponsesChain(providerNames)
        ? upstreamUrl
        : resolveConfigUrl(config.url) ?? upstreamUrl;
      const fetchUrl = antigravityFailoverUrl ?? chainUrl;

      console.info(
        `[AgentProxy:subscription] REQ#${req.reqId} | provider=${this.profile.providerId} -> ${fetchUrl} model=${currentModel} attempt=${attempted.length}`,
      );

      try {
        const upstream = await this.hooks.fetchWithRetry(fetchUrl, headers, requestBody, wireModel);
        // D5 RECORD: returned response from `fetchWithRetry` is always 2xx → success.
        this.profile.recordModelOutcome?.(currentModel, true);
        this.markHealth(usedAccountId, 200);
        const finalResponse = bypass ? upstream : await this.hooks.executor.executeResponseChain(
          endpointRequest ?? requestBody as UnifiedChatRequest,
          upstream,
          transformerProvider,
          { providerTransformers, modelTransformers },
          { endpointTransformer: this.hooks.endpointTransformer },
        );
        await this.hooks.writeProxyResponse(req.res, finalResponse, req.isStream, req.reqId);
        return;
      } catch (err) {
        const handled = await this.maybeRetryAfterError(err, headers, req, currentModel, sessionKey, upstreamUrl);
        if (handled.retryOnce) {
          try {
            const upstream = await this.hooks.fetchWithRetry(fetchUrl, handled.headers, requestBody, wireModel);
            this.profile.recordModelOutcome?.(currentModel, true);
            this.markHealth(usedAccountId, 200);
            const finalResponse = bypass ? upstream : await this.hooks.executor.executeResponseChain(
              endpointRequest ?? requestBody as UnifiedChatRequest,
              upstream,
              transformerProvider,
              { providerTransformers, modelTransformers },
              { endpointTransformer: this.hooks.endpointTransformer },
            );
            await this.hooks.writeProxyResponse(req.res, finalResponse, req.isStream, req.reqId);
            return;
          } catch (retryErr) {
            // The post-refresh retry threw too — mark the FINAL failure before it
            // propagates (subscription-account-health Minor #2).
            this.markHealth(usedAccountId, errStatus(retryErr), retryErr);
            throw retryErr;
          }
        }
        // D5 RECORD: status trichotomy on the caught error (LEAD OQ1 = parity).
        if (caughtErrorBreakerOutcome(err) === 'failure') {
          this.profile.recordModelOutcome?.(currentModel, false);
        }
        this.markHealth(usedAccountId, errStatus(err), err);
        // Antigravity sandbox failover (design D5): retry the SAME model once
        // on the sandbox endpoint when the switch is ON and the failure is
        // retryable. With the switch OFF this is a no-op (null) and the error
        // semantics below are unchanged.
        if (this.profile.providerId === 'antigravity' && antigravityFailoverUrl === null) {
          const failover = maybeAntigravityFailoverUrl(
            upstreamUrl,
            errStatus(err),
            errBodyText(err) ?? undefined,
          );
          if (failover) {
            antigravityFailoverUrl = failover;
            console.warn(
              `[AgentProxy:subscription] REQ#${req.reqId} | antigravity endpoint failover -> ${failover} after ${
                errStatus(err) ?? 'transport error'
              }`,
            );
            continue;
          }
        }
        const next = this.profile.nextFallback?.(scenario, attempted, ocConfig);
        if (!next || attempted.length >= MAX_FALLBACK_ATTEMPTS_LOCAL) {
          throw err;
        }
        console.warn(
          `[AgentProxy:subscription] REQ#${req.reqId} | ${this.profile.providerId} fallback ${currentModel} -> ${next.modelId} after error:`,
          serializeError(err),
        );
        currentModel = next.modelId;
      }
    }
  }

  /**
   * D2 PRIMARY-GATING (opencodego, D5): pick the first-attempt model for a
   * fallback loop. Consults the breaker for the mapped primary; when the primary's
   * circuit is open, advance to the first admitting `nextFallback` candidate
   * WITHOUT an upstream round-trip on the open primary. When EVERY candidate is
   * open (all-open) the breaker FAILS OPEN — it attempts the original primary
   * anyway. Returns the resolved first-attempt model plus the `attempted` list
   * seeded for the loop (the SKIPPED primary is recorded at chain index 0 so the
   * loop's `nextFallback` excludes it; on fail-open the list is left empty so the
   * primary is the first real attempt). When the profile has no `allowModel`
   * (claude / codex / gemini, or breaker unset) this is byte-identical to the
   * prior behavior: the primary is the first attempt, `attempted` empty.
   */
  private gatePrimaryModel(
    primaryModel: string,
    scenario: OpenCodeGoScenario,
    ocConfig: OpenCodeGoTokenConfig | undefined,
  ): { firstModel: string; attempted: string[] } {
    if (!this.profile.allowModel || this.profile.allowModel(primaryModel)) {
      return { firstModel: primaryModel, attempted: [] };
    }
    // Primary's circuit is open — try the first admitting fallback.
    const skipped = [primaryModel];
    const firstAdmitting = this.profile.nextFallback?.(scenario, skipped, ocConfig);
    if (firstAdmitting) {
      console.warn(
        `[AgentProxy:subscription] opencodego primary ${primaryModel} circuit open -> first admitting fallback ${firstAdmitting.modelId}`,
      );
      return { firstModel: firstAdmitting.modelId, attempted: skipped };
    }
    // All circuits open — FAIL OPEN to the primary (empty `attempted`).
    console.warn(
      `[AgentProxy:subscription] all opencodego circuits open -> fail open to primary ${primaryModel}`,
    );
    return { firstModel: primaryModel, attempted: [] };
  }

  /**
   * On a 401 error from the upstream, ask the AuthStrategy whether to retry.
   * Returns `{ retryOnce: true, headers }` when the strategy refreshed
   * successfully (caller should retry once); otherwise re-throws.
   */
  private async maybeRetryAfterError(
    err: unknown,
    headers: Record<string, string>,
    req: DispatchRequest,
    resolvedModel: string,
    sessionKey: string | undefined,
    upstreamUrl: string,
  ): Promise<{ retryOnce: boolean; headers: Record<string, string> }> {
    const status = (err as { status?: number })?.status ?? 0;
    if (status !== 401) {
      return { retryOnce: false, headers };
    }
    // Refresh the account actually served (D7) — threads the session key so a
    // sticky non-active pooled account refreshes by id.
    const refreshed = await this.profile.authStrategy.onUnauthorized(sessionKey);
    if (!refreshed) {
      console.warn(
        `[AgentProxy:subscription] REQ#${req.reqId} | 401 not recoverable for provider=${this.profile.providerId}`,
      );
      return { retryOnce: false, headers };
    }
    // Re-apply headers with the freshly-refreshed credential.
    const fresh: Record<string, string> = { ...headers };
    stripAuthHeaders(fresh);
    await this.applyHeadersWithRetry(fresh, { upstreamUrl, resolvedModel, sessionKey });
    return { retryOnce: true, headers: fresh };
  }

  private async applyHeadersWithRetry(
    headers: Record<string, string>,
    hints: AuthApplyHints,
  ): Promise<void> {
    try {
      await this.profile.authStrategy.applyHeaders(headers, hints);
    } catch (err) {
      if (isAccountAllowanceExhaustedError(err) || isBoundAccountSelectionError(err)) throw err;
      console.warn('[AgentProxy:subscription] authStrategy.applyHeaders threw:', serializeError(err));
    }
  }

  /**
   * Mark the served account's health against ONE attempt's outcome
   * (subscription-account-health, task 3.4). No-op when no account was reported
   * (non-pooled / single-account) or on a session-cancel (status 0). On a caught
   * error `err` is passed so the 429-reset / 403-ban drivers are read STRUCTURALLY
   * from the error's upstream `headers` + `bodyText` (the `fetchWithRetry`
   * contract) — so daemon-path 429 cooldown + ban blocking function for
   * multi-account codex/gemini/opencodego pools; absent headers ⇒ a bare-429
   * (unmarked, lazy re-probe). Success (2xx) clears; 401/5xx/thrown → transient.
   */
  private markHealth(accountId: string | undefined, status: number | null, err?: unknown): void {
    if (accountId === undefined || status === 0) return;
    const headers = err !== undefined ? errHeaders(err) : undefined;
    const reset = headers
      ? resolveResetSeconds(this.profile.providerId, headers)
      : { resetHeaderSeconds: null, retryAfterSeconds: null };
    const bodyText = status === 403 && err !== undefined ? errBodyText(err) : undefined;
    getSharedAccountHealth().recordUpstreamOutcome(this.profile.providerId, accountId, {
      status,
      resetHeaderSeconds: reset.resetHeaderSeconds,
      retryAfterSeconds: reset.retryAfterSeconds,
      bodyText,
    });
  }

  /**
   * Resolve the Code Assist project using the bearer selected for this attempt,
   * so project discovery and the request cannot use different pooled accounts.
   * Runs the cached handshake. Returns
   * `undefined` for a fresh free-tier account (valid — the envelope omits the
   * project). A handshake hard failure (403/429) propagates to the dispatch
   * error handler.
   */
  private async resolveGeminiProject(accessToken: string): Promise<string | undefined> {
    if (!accessToken) return undefined;
    // Resolve via the injected `@omnicross/core` Gemini Code Assist port (host
    // wires the concrete resolver at bootstrap). In the running app the resolver
    // is always wired, so this is behavior-identical to the prior dynamic host
    // import; a missing injection now yields a defensive `undefined` instead of a
    // host-path-resolution throw (strictly safer).
    const resolver = getGeminiCodeAssistResolver();
    if (!resolver) return undefined;
    return resolver.resolveProject(accessToken);
  }

  private resolveTransformers(names: readonly string[] | undefined): Transformer[] {
    if (!names || names.length === 0) return [];
    const resolved: Transformer[] = [];
    for (const name of names) {
      const t = this.hooks.transformerService.getTransformer(name);
      if (!t) {
        console.warn(`[AgentProxy:subscription] Transformer not registered: ${name}`);
        continue;
      }
      // The TransformerService caches instantiation; we treat ALL values as
      // instances here since `BuiltinTransformers` registers ctor classes
      // which the service materializes lazily.
      const instance = (typeof t === 'function')
        ? new (t as new () => Transformer)()
        : t;
      resolved.push(instance);
    }
    return resolved;
  }

  /** Build a lightweight request summary for OpenCodeGo scenario routing. */
  private buildRequestSummary(anthropicBody: Record<string, unknown>): SubscriptionRequestSummary {
    const messages = Array.isArray(anthropicBody.messages) ? anthropicBody.messages : [];

    // Estimate tokens from system + messages content. The function is sync
    // and uses cl100k_base when the encoder has been warmed; falls back to
    // chars/4 otherwise. This is good enough for the routing decision —
    // we're picking between scenario buckets, not metering cost.
    const text: string[] = [];
    const system = anthropicBody.system;
    if (typeof system === 'string') {
      text.push(system);
    } else if (Array.isArray(system)) {
      for (const block of system) {
        if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
          text.push(block.text);
        }
      }
    }
    for (const msg of messages) {
      const m = msg as Record<string, unknown>;
      const c = m.content;
      if (typeof c === 'string') {
        text.push(c);
      } else if (Array.isArray(c)) {
        for (const block of c) {
          if (block && typeof block === 'object') {
            const b = block as Record<string, unknown>;
            if (b.type === 'text' && typeof b.text === 'string') {
              text.push(b.text);
            } else if (b.type === 'tool_result' && typeof b.content === 'string') {
              text.push(b.content);
            }
          }
        }
      }
    }

    return {
      messageCount: messages.length,
      estimatedInputTokens: estimateTokensCachedSync(text.join('\n')),
      // Shared core flattener (single source of truth) so this dispatcher path
      // and the core `/v1/messages` path produce IDENTICAL `matchText` for the
      // same body — equivalence by construction. `@omnicross/subscriptions` →
      // `@omnicross/core` is the allowed direction; core imports nothing back.
      matchText: collectMatchText(anthropicBody),
    };
  }
}

/** Local copy of the FallbackChain cap so we don't reach into that module
 *  at every loop iteration. Kept in sync with `MAX_FALLBACK_ATTEMPTS`. */
const MAX_FALLBACK_ATTEMPTS_LOCAL = 3;

/**
 * Classify a CAUGHT dispatch error for the circuit breaker (D5 / LEAD OQ1 =
 * PARITY with the core loop's `breakerOutcome`). The dispatcher's
 * `fetchWithRetry` throws a `ProviderApiError` carrying the upstream HTTP status
 * (`err.status`) on any non-ok response; a true network failure throws a
 * status-LESS `Error`. We read `(err as { status?: number }).status`
 * structurally — the SAME shape `maybeRetryAfterError` already uses — so no new
 * import is needed.
 *   - `failure` : status-LESS throw (genuine network/transport failure — a
 *                 model-health signal), `status >= 500`, or `429`.
 *   - `neutral` : a non-429 `4xx` (a client error fails identically on every
 *                 model — MUST NOT open the breaker; NOT recorded), OR
 *                 `status === 0` — the EXCLUSIVE cancel sentinel
 *                 `ProviderApiError(0, 'Request cancelled: session stopped')`
 *                 thrown by the host proxy's `stop()` (status 0 maps ONLY to
 *                 cancel: genuine network failures throw status-less `Error`s,
 *                 and `lastStatusCode` is always >= 400). A user/session cancel
 *                 is NOT a model-health signal — 3 cancels in a row MUST NOT open
 *                 a healthy model's circuit.
 * A returned response from `fetchWithRetry` is ALWAYS 2xx (non-ok throws), so the
 * success side is recorded directly at the call site (not here).
 */
/** The HTTP status a caught dispatch error carries, or `null` for a status-less
 *  (genuine network) throw — the value `markHealth` records against the account. */
function errStatus(err: unknown): number | null {
  const status = (err as { status?: number })?.status;
  return typeof status === 'number' ? status : null;
}

/** The upstream response headers a caught `ProviderApiError` may carry (a `Headers`
 *  or a plain record), for the daemon-path 429-reset / retry-after resolution.
 *  `undefined` when the error doesn't expose them (⇒ bare-429 degrade). */
function errHeaders(err: unknown): HeadersLike | undefined {
  const h = (err as { headers?: unknown })?.headers;
  if (!h) return undefined;
  if (typeof (h as { get?: unknown }).get === 'function') return h as HeadersLike;
  if (typeof h === 'object') return h as HeadersLike;
  return undefined;
}

/** A bounded upstream body text a caught 403 may carry (for the ban sniff). */
function errBodyText(err: unknown): string | undefined {
  const e = err as { bodyText?: unknown; body?: unknown };
  const raw = typeof e?.bodyText === 'string' ? e.bodyText : typeof e?.body === 'string' ? e.body : undefined;
  return raw?.slice(0, 2048);
}

function caughtErrorBreakerOutcome(err: unknown): 'failure' | 'neutral' {
  const status = (err as { status?: number })?.status;
  if (typeof status !== 'number') return 'failure'; // status-less throw = genuine network failure
  if (status === 0) return 'neutral'; // cancel sentinel — not a model-health signal
  if (status >= 500 || status === 429) return 'failure';
  if (status >= 400 && status < 500) return 'neutral'; // non-429 4xx — client error
  return 'failure'; // any other non-2xx oddity defaults to the safe "failure" side
}

/**
 * Whether the resolved provider chain is the Responses chain (`openai-response`).
 * That transformer emits an ABSOLUTE-path `config.url` that discards the base
 * PATH prefix, so for it the profile's complete `upstreamUrl` must win over
 * `config.url` (see the call site). Other chains (gemini per-model, opencodego
 * chat) either need `config.url` (gemini) or don't set one (opencodego), so they
 * keep the normal `config.url ?? upstreamUrl` preference.
 */
function usesResponsesChain(names: readonly string[] | undefined): boolean {
  return !!names && names.includes('openai-response');
}

/** Normalize a transformer-supplied `config.url` (URL | string | undefined) to
 *  a string, or `null` when the transformer didn't set one. */
function resolveConfigUrl(url: unknown): string | null {
  if (url instanceof URL) return url.toString();
  if (typeof url === 'string' && url.length > 0) return url;
  return null;
}

/** Drop auth headers the transformer chain may have set so the AuthStrategy
 *  is the single source of truth for outbound authentication. */
function stripAuthHeaders(headers: Record<string, string>): void {
  delete headers.authorization;
  delete headers.Authorization;
  delete headers['x-api-key'];
  delete headers['X-Api-Key'];
  delete headers['x-goog-api-key'];
  delete headers['X-Goog-Api-Key'];
}
