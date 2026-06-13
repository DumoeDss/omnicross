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

import type { OpenCodeGoScenario, OpenCodeGoTokenConfig } from '@omnicross/contracts/subscription-types';
import { getGeminiCodeAssistResolver } from '@omnicross/core/ports/gemini-code-assist-resolver';
import { collectMatchText } from '@omnicross/core/provider-proxy/matchText';
import { serializeError } from '@omnicross/core/serializeError';
import type { TransformerChainExecutor } from '@omnicross/core/transformer/TransformerChainExecutor';
import type { TransformerService } from '@omnicross/core/transformer/TransformerService';
import type {
  LLMProvider as TransformerLLMProvider,
  Transformer,
  UnifiedChatRequest,
} from '@omnicross/core/transformer/types';

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
  /** Fetch + retry helper from the proxy (semaphore, 429/5xx loop). */
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
    // 1. Resolve the model via the profile's mapper (OpenCodeGo scenario
    //    routing). For other profiles the mapper is undefined and we keep
    //    the SDK-resolved model as-is.
    const ocConfig = this.profile.providerId === 'opencodego'
      ? await this.getOpenCodeGoConfig()
      : undefined;

    let scenario: OpenCodeGoScenario = 'default';
    let resolvedModel = req.fallbackModel;
    if (this.profile.modelMapper) {
      const summary = this.buildRequestSummary(req.anthropicBody);
      const mapped = this.profile.modelMapper(req.sdkModel, summary, ocConfig);
      resolvedModel = mapped.resolvedModel;
      scenario = mapped.scenario;
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

    // 3. OpenCodeGo Anthropic-shape bypass — the upstream accepts the SDK's
    //    Anthropic body verbatim, so we skip the transformer chain entirely and
    //    forward the raw body. Mirrors the pass-through path minus the
    //    api.anthropic.com hard-code. The shape is resolved from the RESOLVED
    //    entry's `(provider half, modelId)` (go-MiniMax OR zen-claude/qwen3.7-max),
    //    NOT just the model string — so a zen-anthropic model also bypasses.
    if (
      this.profile.providerId === 'opencodego' &&
      resolveOpenCodeGoShape({
        provider: resolveOpenCodeGoHalf(resolvedModel, ocConfig),
        modelId: resolvedModel,
      }) === 'anthropic'
    ) {
      await this.dispatchAnthropicShapeBypass(req, upstreamUrl, resolvedModel, scenario, ocConfig);
      return;
    }

    // 4. Standard transformer-chain dispatch.
    await this.dispatchTransformerChain(req, upstreamUrl, resolvedModel, scenario, ocConfig);
  }

  /** Bypass path for OpenCodeGo MiniMax models — forwards Anthropic body verbatim. */
  private async dispatchAnthropicShapeBypass(
    req: DispatchRequest,
    upstreamUrl: string,
    resolvedModel: string,
    scenario: OpenCodeGoScenario,
    ocConfig: OpenCodeGoTokenConfig | undefined,
  ): Promise<void> {
    // D2 PRIMARY-GATING (D5): consult the breaker for the mapped primary; an open
    // primary jumps straight to the first admitting fallback (all-open ⇒ fail open).
    const gate = this.gatePrimaryModel(resolvedModel, scenario, ocConfig);
    const attempted: string[] = gate.attempted;
    let currentModel = gate.firstModel;

    // KNOWN LIMITATION (see opencodego-zen-provider design.md Open Questions):
    // this loop resolves the upstream URL (and chain, where applicable) ONCE
    // and only swaps the model — SINGLE-SHAPE fallback only. A half/shape-
    // flipping fallback entry would post to the primary's URL (fails loud with
    // an upstream 4xx). The core /v1/messages path rebuilds per-iteration;
    // hoisting that here is a deferred follow-up.
    while (attempted.length < MAX_FALLBACK_ATTEMPTS_LOCAL) {
      attempted.push(currentModel);
      req.anthropicBody.model = currentModel;

      const headers: Record<string, string> = { 'content-type': 'application/json' };
      await this.applyHeadersWithRetry(headers, { upstreamUrl, resolvedModel: currentModel });

      console.info(
        `[AgentProxy:subscription] REQ#${req.reqId} | opencodego anthropic-shape -> ${upstreamUrl} model=${currentModel} attempt=${attempted.length}`,
      );

      try {
        const upstream = await this.hooks.fetchWithRetry(upstreamUrl, headers, req.anthropicBody, currentModel);
        // D5 RECORD: a returned response from `fetchWithRetry` is always 2xx
        // (non-ok throws) → success. Recorded BEFORE relay so the breaker updates
        // even if the SDK disconnects mid-relay.
        this.profile.recordModelOutcome?.(currentModel, true);
        await this.hooks.writeProxyResponse(req.res, upstream, req.isStream, req.reqId);
        return;
      } catch (err) {
        const handled = await this.maybeRetryAfterError(err, headers, req, currentModel);
        if (handled.retryOnce) {
          const upstream = await this.hooks.fetchWithRetry(upstreamUrl, handled.headers, req.anthropicBody, currentModel);
          this.profile.recordModelOutcome?.(currentModel, true);
          await this.hooks.writeProxyResponse(req.res, upstream, req.isStream, req.reqId);
          return;
        }
        // D5 RECORD: status trichotomy on the caught error (LEAD OQ1 = parity).
        // A non-429 4xx is NEUTRAL (not recorded); throw / 5xx / 429 → failure.
        if (caughtErrorBreakerOutcome(err) === 'failure') {
          this.profile.recordModelOutcome?.(currentModel, false);
        }
        // Fallback to next OpenCodeGo model if available.
        const next = this.profile.nextFallback?.(scenario, attempted, ocConfig);
        if (!next || attempted.length >= MAX_FALLBACK_ATTEMPTS_LOCAL) {
          throw err;
        }
        console.warn(
          `[AgentProxy:subscription] REQ#${req.reqId} | opencodego fallback ${currentModel} -> ${next.modelId} after error:`,
          serializeError(err),
        );
        currentModel = next.modelId;
      }
    }
  }

  /** Standard subscription transformer chain — Codex/Gemini/OpenCodeGo OpenAI-shape. */
  private async dispatchTransformerChain(
    req: DispatchRequest,
    upstreamUrl: string,
    resolvedModel: string,
    scenario: OpenCodeGoScenario,
    ocConfig: OpenCodeGoTokenConfig | undefined,
  ): Promise<void> {
    // zen seam: when the profile varies its chain by resolved shape (opencodego),
    // consult `resolveProviderTransformerNames(resolvedModel, ocConfig)` — so a zen
    // `responses` model runs `['openai-response']`, `gemini` runs `['gemini']`, and
    // `chat` runs `['opencodego']`. Absent (claude/codex/gemini) ⇒ the static
    // `providerTransformerNames`, byte-identical.
    const providerNames =
      this.profile.resolveProviderTransformerNames?.(resolvedModel, ocConfig) ??
      this.profile.providerTransformerNames;
    const providerTransformers = this.resolveTransformers(providerNames);
    const modelTransformers = this.resolveTransformers(this.profile.modelTransformerNames);

    const transformerProvider: TransformerLLMProvider = {
      name: this.profile.providerId,
      baseUrl: upstreamUrl,
      apiKey: '',  // Subscription mode uses AuthStrategy; transformer auth is stripped.
      models: [resolvedModel],
    };

    // Gemini Code Assist (shape-C / Anthropic-ingress path): resolve + thread the
    // Code Assist project id onto the transformer provider so the
    // `gemini-code-assist` transformer can embed it in the envelope. SEAM CHOICE:
    // stash on `transformerProvider.geminiProject` (option (a) — an optional field
    // the transformer reads) because the transformer only receives `provider` +
    // a minimal `TransformerContext`; this is the least-invasive way to pass
    // per-account data without widening the executor/chain API. A handshake
    // failure throws → surfaced as the dispatch error (defensive).
    if (this.profile.providerId === 'gemini') {
      transformerProvider.geminiProject = await this.resolveGeminiProject();
    }

    // D2 PRIMARY-GATING (D5): an open primary jumps to the first admitting
    // fallback (all-open ⇒ fail open). No-op for non-opencodego profiles (no
    // `allowModel`) → byte-identical first attempt on the mapped primary.
    const gate = this.gatePrimaryModel(resolvedModel, scenario, ocConfig);
    const attempted: string[] = gate.attempted;
    let currentModel = gate.firstModel;

    // KNOWN LIMITATION (see opencodego-zen-provider design.md Open Questions):
    // this loop resolves the upstream URL (and chain, where applicable) ONCE
    // and only swaps the model — SINGLE-SHAPE fallback only. A half/shape-
    // flipping fallback entry would post to the primary's URL (fails loud with
    // an upstream 4xx). The core /v1/messages path rebuilds per-iteration;
    // hoisting that here is a deferred follow-up.
    while (attempted.length < MAX_FALLBACK_ATTEMPTS_LOCAL) {
      attempted.push(currentModel);
      req.anthropicBody.model = currentModel;

      const { requestBody, config } = await this.hooks.executor.executeRequestChain(
        req.anthropicBody,
        transformerProvider,
        { providerTransformers, modelTransformers },
        { endpointTransformer: this.hooks.endpointTransformer },
      );

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(config.headers as Record<string, string> | undefined),
      };
      stripAuthHeaders(headers);
      await this.applyHeadersWithRetry(headers, { upstreamUrl, resolvedModel: currentModel });

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
      const fetchUrl = usesResponsesChain(providerNames)
        ? upstreamUrl
        : resolveConfigUrl(config.url) ?? upstreamUrl;

      console.info(
        `[AgentProxy:subscription] REQ#${req.reqId} | provider=${this.profile.providerId} -> ${fetchUrl} model=${currentModel} attempt=${attempted.length}`,
      );

      try {
        const upstream = await this.hooks.fetchWithRetry(fetchUrl, headers, requestBody, currentModel);
        // D5 RECORD: returned response from `fetchWithRetry` is always 2xx → success.
        this.profile.recordModelOutcome?.(currentModel, true);
        const finalResponse = await this.hooks.executor.executeResponseChain(
          requestBody as UnifiedChatRequest,
          upstream,
          transformerProvider,
          { providerTransformers, modelTransformers },
          { endpointTransformer: this.hooks.endpointTransformer },
        );
        await this.hooks.writeProxyResponse(req.res, finalResponse, req.isStream, req.reqId);
        return;
      } catch (err) {
        const handled = await this.maybeRetryAfterError(err, headers, req, currentModel);
        if (handled.retryOnce) {
          const upstream = await this.hooks.fetchWithRetry(fetchUrl, handled.headers, requestBody, currentModel);
          this.profile.recordModelOutcome?.(currentModel, true);
          const finalResponse = await this.hooks.executor.executeResponseChain(
            requestBody as UnifiedChatRequest,
            upstream,
            transformerProvider,
            { providerTransformers, modelTransformers },
            { endpointTransformer: this.hooks.endpointTransformer },
          );
          await this.hooks.writeProxyResponse(req.res, finalResponse, req.isStream, req.reqId);
          return;
        }
        // D5 RECORD: status trichotomy on the caught error (LEAD OQ1 = parity).
        if (caughtErrorBreakerOutcome(err) === 'failure') {
          this.profile.recordModelOutcome?.(currentModel, false);
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
  ): Promise<{ retryOnce: boolean; headers: Record<string, string> }> {
    const status = (err as { status?: number })?.status ?? 0;
    if (status !== 401) {
      return { retryOnce: false, headers };
    }
    const refreshed = await this.profile.authStrategy.onUnauthorized();
    if (!refreshed) {
      console.warn(
        `[AgentProxy:subscription] REQ#${req.reqId} | 401 not recoverable for provider=${this.profile.providerId}`,
      );
      return { retryOnce: false, headers };
    }
    // Re-apply headers with the freshly-refreshed credential.
    const fresh: Record<string, string> = { ...headers };
    stripAuthHeaders(fresh);
    await this.applyHeadersWithRetry(fresh, { upstreamUrl: '', resolvedModel });
    return { retryOnce: true, headers: fresh };
  }

  private async applyHeadersWithRetry(
    headers: Record<string, string>,
    hints: { upstreamUrl: string; resolvedModel: string },
  ): Promise<void> {
    try {
      await this.profile.authStrategy.applyHeaders(headers, hints);
    } catch (err) {
      console.warn('[AgentProxy:subscription] authStrategy.applyHeaders threw:', serializeError(err));
    }
  }

  /**
   * Resolve the Code Assist project for the gemini subscription profile. Pulls
   * the Bearer the bound `AuthStrategy` would inject (so the strategy stays the
   * single source of the token), then runs the cached handshake. Returns
   * `undefined` for a fresh free-tier account (valid — the envelope omits the
   * project). A handshake hard failure (403/429) propagates to the dispatch
   * error handler.
   */
  private async resolveGeminiProject(): Promise<string | undefined> {
    const probe: Record<string, string> = {};
    await this.applyHeadersWithRetry(probe, { upstreamUrl: '', resolvedModel: '' });
    const bearer = probe.Authorization ?? probe.authorization ?? '';
    const accessToken = bearer.replace(/^Bearer\s+/i, '').trim();
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
    let totalChars = 0;
    const system = anthropicBody.system;
    if (typeof system === 'string') {
      totalChars += system.length;
    } else if (Array.isArray(system)) {
      for (const block of system) {
        if (block && typeof block === 'object' && 'text' in block) {
          totalChars += String((block as { text?: unknown }).text ?? '').length;
        }
      }
    }
    for (const msg of messages) {
      const m = msg as Record<string, unknown>;
      const c = m.content;
      if (typeof c === 'string') {
        totalChars += c.length;
      } else if (Array.isArray(c)) {
        for (const block of c) {
          if (block && typeof block === 'object') {
            const b = block as Record<string, unknown>;
            if (b.type === 'text' && typeof b.text === 'string') {
              totalChars += b.text.length;
            } else if (b.type === 'tool_result' && typeof b.content === 'string') {
              totalChars += b.content.length;
            }
          }
        }
      }
    }

    return {
      messageCount: messages.length,
      estimatedInputTokens: estimateTokensCachedSync('x'.repeat(totalChars)),
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
