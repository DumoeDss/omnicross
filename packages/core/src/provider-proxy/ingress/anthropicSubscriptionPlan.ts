/**
 * anthropicSubscriptionPlan — the subscription half of the built-in, factory-less
 * Anthropic `/v1/messages` path (`omnicross-anthropic-subscription-ingress`,
 * RT2.1 + `opencodego-zen-provider` Phase 3).
 *
 * Extracted from `anthropicMessagesByo.ts` (line-cap mitigation, Phase 3 task 3.1)
 * so the ingress file stays a thin dispatcher UNDER its `max-lines` cap. This is a
 * PURE MOVE — behavior unchanged — PLUS the zen shape-aware chain selection
 * (Phase 3 task 3.2/3.3): `buildSubscriptionIterationPlan` now resolves the
 * provider transformer chain NAMES per resolved shape via the profile's OPTIONAL
 * `resolveProviderTransformerNames` seam (absent ⇒ static `providerTransformerNames`,
 * codex byte-identity).
 *
 * Holds: the subscription plan builders (`buildSubscriptionPlan` /
 * `buildSubscriptionIterationPlan` / `buildSubscriptionRequestSummary` /
 * `collectText`), the shared `runPipeline` (one shared-core pass with the
 * Anthropic endpoint transformer — used by BOTH the BYO and subscription relays),
 * the shared plan/options types, and the fallback-loop wrapper
 * (`runPipelineWithSubscriptionRetry` + its `runSubscription*` helpers +
 * `breakerOutcome` / `isFallbackEligibleStatus` / `recordBreakerOutcome`).
 *
 * Core imports NOTHING from `@omnicross/subscriptions` — the same-format signal +
 * chain-name selection are computed from CORE-LOCAL profile fields
 * (`profile.mode`, `upstreamUrl.endsWith('/v1/messages')`, the OPTIONAL
 * `resolveProviderTransformerNames`/`providerTransformerNames`), and the opaque
 * `route.subscriptionConfig` is held as `unknown`.
 *
 * @module provider-proxy/ingress/anthropicSubscriptionPlan
 */

import type http from 'node:http';

import type { LLMProvider } from '@omnicross/contracts/llm-config';
import type { OpenCodeGoScenario } from '@omnicross/contracts/subscription-types';

import type { AuthSource } from '../../pipeline/AuthSource';
import { executeProviderCall } from '../../pipeline/executeProviderCall';
import { resolveSubscriptionChain } from '../../pipeline/resolveSubscriptionChain';
import {
  type SubscriptionAuthProfile,
  SubscriptionAuthSource,
} from '../../pipeline/SubscriptionAuthSource';
import type {
  LLMProvider as TransformerLLMProvider,
  RequestConfig,
  ResolvedTransformerChain,
} from '../../transformer';
import { collectMatchText, deriveSubscriptionSessionKey } from '../matchText';
import type {
  ProviderProxyDeps,
  RouteContext,
  SubscriptionRequestSummary,
} from '../types';

import {
  getAnthropicEndpointTransformer,
  getSharedExecutor,
  writeError,
} from './providerProxyShared';

/** Optional inputs threaded from the ingress handler (which holds the raw `req`). */
export interface AnthropicByoOptions {
  /** The caller's request-side `anthropic-beta` header value, forwarded/merged
   *  onto the outbound request on the same-format fast path (LEAD OQ1). */
  readonly callerAnthropicBeta?: string | null;
}

/**
 * The auth-mode-resolved inputs for one `/v1/messages` exchange. The
 * `isSubscription` discriminant (D2) is the plan-level source of truth for which
 * relay runs: subscription plans drive `runSubscriptionSameFormatFetch` /
 * `runPipeline` (headers from the AuthStrategy), BYO plans drive
 * `runSameFormatFetch` / `runPipeline` (headers from `getProviderHeaders`). The
 * BYO-only fields (`provider`, `apiKey`, `extendedContextEnabled`) are OPTIONAL —
 * a subscription plan omits them.
 */
export interface AnthropicCallPlan {
  readonly auth: AuthSource;
  readonly chain: ResolvedTransformerChain;
  readonly transformerProvider: TransformerLLMProvider;
  readonly resolvedModel: string;
  readonly isStream: boolean;
  readonly resolveUrl: (config: RequestConfig) => string;
  readonly upstreamUrl: string;
  /** BYO: the target provider speaks the `anthropic` wire. Subscription: the
   *  profile is pass-through OR the resolved upstream URL ends in `/v1/messages`.
   *  Either way it drives the verbatim same-format fast path (D4 / D3). */
  readonly sameFormat: boolean;
  /** Discriminant (D2): which relay/run-wrapper family services this plan. */
  readonly isSubscription: boolean;
  /** opencodego scenario the `modelMapper` bucketed into — carried so the
   *  fallback loop (D6b) can pass it to `nextFallback`. `undefined` for BYO /
   *  non-opencodego / unmapped subscription plans (no fallback chain). */
  readonly scenario?: OpenCodeGoScenario;
  /** Provider row + resolved FIRST-CHOICE key — BYO-only; needed by the BYO
   *  same-format fast path to build `anthropic`-format headers and the verbatim
   *  fetch. NOTE: on an ApiKeyPool rebind the same-format retry does NOT read this
   *  field — the failover wrapper passes the rotated `newKey` explicitly so the
   *  verbatim retry sends the rebound key (the transformer path picks the rotated
   *  key up via `auth.applyHeaders` → `LlmConfigProviderAuth.apiKey`). */
  readonly provider?: LLMProvider;
  readonly apiKey?: string;
  /** Route 1M-context opt-in (BYO same-format fast path beta injection). */
  readonly extendedContextEnabled?: boolean;
  /** Stable per-conversation session key (subscription-account-scheduling, D5) —
   *  threaded into `auth.applyHeaders`/`onUnauthorized` so the account pool's
   *  sticky affinity holds across a conversation's turns and its 401 retry. Derived
   *  once in `buildSubscriptionPlan` and carried across fallback iterations.
   *  `undefined` for BYO / no-anchor requests (⇒ pure priority/LRU). */
  readonly sessionKey?: string;
}

/**
 * Subscription plan (D6/D5/D3) — `SubscriptionAuthSource` over the route's
 * profile. Reads `route.subscriptionProfile` (set by the route resolver for the
 * `anthropic-messages` ingress, RT2.1); applies the profile's `modelMapper`
 * (opencodego scenario routing) to derive the resolved model BEFORE resolving the
 * upstream URL — so the shape (Anthropic `/v1/messages` vs OpenAI
 * `/v1/chat/completions` vs zen responses/gemini) is picked correctly. The
 * same-format signal is CORE-LOCAL (`profile.mode === 'pass-through'` OR the
 * resolved upstream URL ends in `/v1/messages`) — no `@omnicross/subscriptions`
 * import, no `detectOpenCodeGoShape`. The transformer chain is only built/used on
 * the non-same-format path.
 */
export async function buildSubscriptionPlan(
  res: http.ServerResponse,
  route: RouteContext,
  deps: ProviderProxyDeps,
  anthropicBody: Record<string, unknown>,
  routeModel: string,
  isStream: boolean,
): Promise<AnthropicCallPlan | null> {
  const profile = route.subscriptionProfile;
  if (!profile) {
    writeError(res, 502, 'Subscription mode requires an Anthropic subscription profile');
    return null;
  }

  // D6: apply the profile's model mapper (opencodego) BEFORE resolving the
  // upstream URL. The summary's token count uses a CORE-LOCAL chars/4 estimate
  // (NOT `@omnicross/subscriptions`'s encoder) — the mapper only buckets by
  // scenario threshold, for which chars/4 is the documented fallback. The REAL
  // per-account config (the opaque `route.subscriptionConfig`) is passed through
  // so a user `modelMap.<scenario>` override selects the user's model id (D6a /
  // D3-note ③). Core holds the config as `unknown` and hands it back as `never`
  // — it never names `OpenCodeGoTokenConfig`.
  let resolvedModel = routeModel;
  let scenario: OpenCodeGoScenario | undefined;
  if (profile.modelMapper) {
    const summary = buildSubscriptionRequestSummary(anthropicBody);
    const mapped = profile.modelMapper(routeModel, summary, route.subscriptionConfig as never);
    resolvedModel = mapped.resolvedModel;
    scenario = mapped.scenario;
  }

  // Derive the account-pool session key ONCE (D5) from the stable request anchor
  // and carry it on every iteration plan (fallbacks reuse it).
  const sessionKey = deriveSubscriptionSessionKey(anthropicBody);

  const plan = buildSubscriptionIterationPlan(profile, route, deps, resolvedModel, isStream, scenario, sessionKey);
  if (!plan) {
    writeError(res, 502, 'Subscription profile is missing resolveUpstreamUrl');
    return null;
  }
  return plan;
}

/**
 * Build the per-model `AnthropicCallPlan` for ONE opencodego/subscription
 * attempt. Pure function of `(profile, currentModel)` + the opaque
 * `route.subscriptionConfig` — re-callable by the D6b fallback loop because a
 * fallback model may FLIP shape (across go↔zen, minimax ↔ non-minimax,
 * anthropic ↔ responses ↔ gemini ↔ chat), changing the upstream URL, the
 * same-format decision, AND the transformer chain. The `auth`
 * (`SubscriptionAuthSource`) is per-PROFILE (not per-model — the strategy keys
 * its `x-api-key` injection off the resolved upstream URL hint, recomputed per
 * call), so the SAME auth instance is reused across fallbacks. Returns `null`
 * only when the profile has no `resolveUpstreamUrl` (a misconfigured profile).
 */
export function buildSubscriptionIterationPlan(
  profile: SubscriptionAuthProfile,
  route: RouteContext,
  deps: ProviderProxyDeps,
  resolvedModel: string,
  isStream: boolean,
  scenario: OpenCodeGoScenario | undefined,
  sessionKey?: string,
): AnthropicCallPlan | null {
  // D1: pass the opaque per-account config so the opencodego profile honors a
  // user `baseUrl`/`zenBaseUrl` override + the per-model go/zen half; byte-
  // identical when unset.
  const upstreamUrl = profile.resolveUpstreamUrl?.(resolvedModel, route.subscriptionConfig as never);
  if (!upstreamUrl) return null;

  const auth = route.auth ?? new SubscriptionAuthSource(profile);

  // D3: core-local same-format signal — verbatim relay when the profile is
  // pass-through (claude) OR the resolved upstream is an Anthropic-shape
  // `/v1/messages` endpoint (go-MiniMax OR zen-claude/qwen3.7-max). `.endsWith`
  // (not `.includes`) matches only a terminal `/v1/messages` path — zen responses
  // (`/v1/responses`), zen gemini (`:generateContent…`), zen chat
  // (`/v1/chat/completions`) all correctly return false. This is the SAME
  // `/v1/messages` fragment `StaticBearerAuthStrategy` uses to decide its
  // `x-api-key` injection, so the two stay consistent by construction.
  const sameFormat = profile.mode === 'pass-through' || upstreamUrl.endsWith('/v1/messages');

  // zen seam (Phase 3 task 3.2): resolve the provider transformer chain NAMES per
  // resolved shape via the profile's OPTIONAL `resolveProviderTransformerNames`.
  // Absent (claude/codex/gemini) ⇒ `resolveSubscriptionChain` reads the static
  // `providerTransformerNames` exactly as today (codex byte-identity). `config` is
  // the opaque `route.subscriptionConfig` (core never names its type).
  const overrideNames = profile.resolveProviderTransformerNames?.(
    resolvedModel,
    route.subscriptionConfig as never,
  );

  // D5: only the transformer (non-same-format) path needs the chain. For the
  // verbatim path we still supply a (cheap) fallback chain so the plan shape is
  // uniform, but it is never run.
  const chain: ResolvedTransformerChain = sameFormat
    ? { providerTransformers: [], modelTransformers: [] }
    : resolveSubscriptionChain(
        profile,
        deps.llmConfig.getTransformerService(),
        getAnthropicEndpointTransformer(),
        overrideNames,
      );

  const transformerProvider: TransformerLLMProvider = {
    name: profile.authStrategy.providerId,
    baseUrl: upstreamUrl,
    apiKey: '',
    models: [resolvedModel],
  };

  return {
    auth,
    chain,
    transformerProvider,
    resolvedModel,
    isStream,
    // EXCEPTION (the Responses chain) (Phase 3 task 3.3): the `openai-response`
    // provider transformer emits an ABSOLUTE-path `config.url`
    // (`new URL('/v1/responses', baseUrl)`) that DISCARDS any base PATH prefix — so
    // for a path-prefixed base (zen `https://opencode.ai/zen/v1/responses` → drops
    // `/zen/`; codex `https://chatgpt.com/backend-api/codex/responses` → drops
    // `/backend-api/codex/`). On the core `/v1/messages` plan the endpoint
    // transformer is `anthropic` and the codex/zen-responses chain is
    // `['openai-response']` (endpoint != provider), so `transformRequestIn` RUNS
    // and emits the lossy URL. The guard makes this safe REGARDLESS of whether it
    // ran: `usesResponsesChain(['openai-response'])` captures BOTH codex and zen
    // responses, so the profile's complete `upstreamUrl` always wins (codex → its
    // backend-api/codex/responses; zen → its `/zen/...` endpoint). The gemini
    // chain's `config.url` is RELATIVE (`./{model}:{action}`) and PRESERVES the
    // base path, so it correctly wins. The bypass-by-name optimization only applies
    // on the core OpenAI-Responses ingress (endpoint == `openai-response`), NOT
    // here. `// UNVERIFIED (no live zen key)`.
    resolveUrl: usesResponsesChain(overrideNames ?? profile.providerTransformerNames)
      ? () => upstreamUrl
      : (config) =>
          config.url instanceof URL
            ? config.url.toString()
            : typeof config.url === 'string'
              ? config.url
              : upstreamUrl,
    upstreamUrl,
    sameFormat,
    isSubscription: true,
    scenario,
    sessionKey,
  };
}

/**
 * Whether the resolved provider chain is the Responses chain (`openai-response`).
 * Mirrors `SubscriptionDispatcher.usesResponsesChain` — that transformer's
 * absolute-path `config.url` discards the base path prefix, so the profile's
 * complete `upstreamUrl` must win for it. Other chains keep the normal
 * `config.url ?? upstreamUrl` preference.
 */
function usesResponsesChain(names: readonly string[] | undefined): boolean {
  return !!names && names.includes('openai-response');
}

/**
 * Build the `SubscriptionRequestSummary` the opencodego `modelMapper` consumes,
 * using a CORE-LOCAL `Math.ceil(totalChars / 4)` token estimate over the
 * system + message text (the documented chars/4 fallback used when
 * the cl100k encoder is cold — good enough for scenario bucketing). Deliberately
 * does NOT import `@omnicross/subscriptions`'s `estimateTokensCachedSync`.
 */
export function buildSubscriptionRequestSummary(
  anthropicBody: Record<string, unknown>,
): SubscriptionRequestSummary {
  const messages = Array.isArray(anthropicBody.messages) ? anthropicBody.messages : [];
  let totalChars = collectText(anthropicBody.system);
  for (const message of messages) {
    if (message && typeof message === 'object') {
      totalChars += collectText((message as Record<string, unknown>).content);
    }
  }
  return {
    messageCount: messages.length,
    estimatedInputTokens: Math.ceil(totalChars / 4),
    // Single source of truth (shared with the dispatcher builder) so both
    // ingress paths yield identical `matchText` for the same body.
    matchText: collectMatchText(anthropicBody),
  };
}

/** Recursively sum the character length of a string / content-block value. */
export function collectText(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) {
    let sum = 0;
    for (const item of value) sum += collectText(item);
    return sum;
  }
  if (value && typeof value === 'object') {
    const text = (value as Record<string, unknown>).text;
    if (typeof text === 'string') return text.length;
  }
  return 0;
}

/**
 * Run the shared core ONCE with the Anthropic endpoint transformer. The endpoint
 * transformer decodes the Anthropic wire → Unified on the request side and
 * re-encodes the target's response → Anthropic wire on the response side
 * (`runResponseChain: true`; `transformResponseIn` auto-detects
 * `text/event-stream` and pipes through `convertOpenAIStreamToAnthropic`), so
 * the BYO caller gets an Anthropic-shaped response regardless of the target
 * provider's wire format. SHARED by both the BYO (`runPipelineWithPoolReporting`)
 * and subscription (`runPipelineWithSubscriptionRetry`) relays.
 */
export async function runPipeline(
  anthropicBody: Record<string, unknown>,
  plan: AnthropicCallPlan,
): Promise<{ response: Response; rawStatus: number | null }> {
  const executor = getSharedExecutor();
  const endpointTransformer = getAnthropicEndpointTransformer();
  const { auth, chain, transformerProvider, resolvedModel, isStream, resolveUrl, upstreamUrl } = plan;

  // Pre-resolve auth headers (applyHeaders MAY be async for OAuth refresh while
  // buildHeaders is sync). Auth wins — chain headers never clobber a key the
  // AuthSource set.
  const authHeaders: Record<string, string> = {};
  await auth.applyHeaders(authHeaders, { upstreamUrl, model: resolvedModel, sessionKey: plan.sessionKey });

  let rawStatus: number | null = null;

  const { response } = await executeProviderCall({
    executor,
    request: anthropicBody,
    provider: transformerProvider,
    chain,
    endpointTransformer,
    resolveUrl,
    buildHeaders: (config) => {
      const headers: Record<string, string> = { ...authHeaders };
      if (config.headers) {
        for (const [key, value] of Object.entries(config.headers as Record<string, string | undefined>)) {
          if (value !== undefined && !(key in headers)) headers[key] = value;
        }
      }
      return headers;
    },
    fetchFn: (url, headers, body) => {
      console.info(`[ProviderProxy:anthropic] -> ${url} model=${resolvedModel} stream=${isStream}`);
      return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }).then((r) => {
        rawStatus = r.status;
        return r;
      });
    },
    runResponseChain: true,
  });

  return { response, rawStatus };
}

/**
 * Subscription verbatim relay (D4) — claude pass-through / opencodego anthropic-
 * shape (go-MiniMax / zen-claude/qwen3.7-max). SKIPS the endpoint transformer +
 * chain and forwards `rawBody` BYTE-FOR-BYTE, preserving Anthropic-native
 * server-tool `type` fields. Headers come from the AuthStrategy (via
 * `SubscriptionAuthSource.applyHeaders`), NOT from `getProviderHeaders`: the
 * strategy injects the OAuth Bearer (claude) or `Bearer + x-api-key` (opencodego,
 * because the upstream ends in `/v1/messages`). The caller's `anthropic-beta`
 * merge (RT1 OQ1) is DEFERRED on this path — the body is forwarded as-is and the
 * upstream applies its defaults.
 */
async function runSubscriptionSameFormatFetch(
  rawBody: string,
  plan: AnthropicCallPlan,
): Promise<{ response: Response; rawStatus: number | null }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  await plan.auth.applyHeaders(headers, {
    upstreamUrl: plan.upstreamUrl,
    model: plan.resolvedModel,
    sessionKey: plan.sessionKey,
  });
  console.info(
    `[ProviderProxy:anthropic] (subscription same-format) -> ${plan.upstreamUrl} model=${plan.resolvedModel} stream=${plan.isStream}`,
  );
  const response = await fetch(plan.upstreamUrl, { method: 'POST', headers, body: rawBody });
  return { response, rawStatus: response.status };
}

/**
 * Run ONE subscription attempt for a given `plan` (same-format verbatim relay OR
 * the transformer pipeline) with the 401-refresh-once wrapper (D7) — mirrors the
 * OpenAI-Responses ingress. If the RAW upstream status was 401 and
 * `auth.onUnauthorized()` resolves true (claude refreshes its OAuth token via the
 * RefreshMutex), re-run ONCE. opencodego's static-bearer `onUnauthorized` returns
 * false → the 401 surfaces. `relayBody` is the verbatim same-format body for THIS
 * attempt (the original `rawBody` on the first attempt; a re-serialized body
 * carrying the fallback model on a fallback iteration). The BYO pool wrapper's
 * `onResult` failover is NOT used (subscription auth has no pool/session).
 */
async function runSubscriptionAttemptWith401Retry(
  anthropicBody: Record<string, unknown>,
  relayBody: string,
  plan: AnthropicCallPlan,
): Promise<{ response: Response; rawStatus: number | null }> {
  const runOnce = (): Promise<{ response: Response; rawStatus: number | null }> =>
    plan.sameFormat
      ? runSubscriptionSameFormatFetch(relayBody, plan)
      : runPipeline(anthropicBody, plan);

  const first = await runOnce();
  if (first.rawStatus !== 401) return first;

  const refreshed = await plan.auth.onUnauthorized?.(plan.sessionKey);
  if (!refreshed) {
    console.warn('[ProviderProxy:anthropic] 401 not recoverable (onUnauthorized returned false)');
    return first;
  }
  console.info('[ProviderProxy:anthropic] 401 → token refreshed; retrying once');
  return runOnce();
}

/**
 * Whether a TRANSIENT upstream failure should advance the opencodego fallback
 * chain. The criterion is deliberately NARROWER than the dispatcher's "advance on
 * any !ok": we only burn a fallback on a failure another model could plausibly
 * survive —
 *  - a thrown / network error (the iteration caught it; `rawStatus === null`),
 *  - `rawStatus >= 500` (upstream-side failure), OR
 *  - `rawStatus === 429` (opencodego rate-limit — the prime "try the next model"
 *    case).
 * Everything else SURFACES (does NOT advance): other 4xx (400/422/… — a client
 * error fails identically on every model) and 401 (already handled by the
 * `onUnauthorized` 401-retry wrapper INSIDE the iteration; opencodego's static
 * `onUnauthorized` returns false → the 401 surfaces). A thrown error reaches here
 * as `rawStatus === null` because the loop CATCHES it per iteration (see below) —
 * it is NOT a bare-fetch reject escaping to the outer 502 handler.
 */
function isFallbackEligibleStatus(rawStatus: number | null): boolean {
  return rawStatus === null || rawStatus >= 500 || rawStatus === 429;
}

/**
 * Classify an attempt's outcome for the circuit breaker (D5 failure table).
 * Pure status logic (no `@omnicross/subscriptions` import) — the loop records
 * ONLY `success` / `failure`, never `neutral`:
 *  - `failure` : thrown/network (`rawStatus === null`), `>= 500`, or `429` — a
 *                model-health signal (EXACTLY the `isFallbackEligibleStatus` set).
 *  - `success` : a `2xx` — clears the consecutive-failure count / drives recovery.
 *  - `neutral` : a non-429 `4xx` (400/401/422/…) — a client error fails
 *                identically on every model, so it MUST NOT open the breaker
 *                (and is NOT recorded). Also covers odd sub-200 statuses.
 */
function breakerOutcome(rawStatus: number | null): 'success' | 'failure' | 'neutral' {
  if (isFallbackEligibleStatus(rawStatus)) return 'failure';
  // rawStatus is non-null here. 2xx ⇒ success; everything else (incl. non-429 4xx) ⇒ neutral.
  if (rawStatus !== null && rawStatus >= 200 && rawStatus < 300) return 'success';
  return 'neutral';
}

/** Record an attempt's outcome to the breaker via the OPTIONAL profile callback
 *  (D3). NEUTRAL (non-429 4xx) records nothing. Core never names the breaker —
 *  it only invokes `profile.recordModelOutcome?` (the `nextFallback` precedent),
 *  so the cross-layer litmus stays 0. A no-op for claude / codex / gemini (which
 *  omit the callback). */
function recordBreakerOutcome(
  profile: SubscriptionAuthProfile | null | undefined,
  modelId: string,
  rawStatus: number | null,
): void {
  const outcome = breakerOutcome(rawStatus);
  if (outcome === 'neutral') return;
  profile?.recordModelOutcome?.(modelId, outcome === 'success');
}

/** One subscription attempt's outcome: either a returned upstream RESULT (any
 *  status, incl. 5xx/429/4xx) or a THROWN error (network/relay reject). The loop
 *  carries the LAST outcome so chain exhaustion surfaces it faithfully (re-throw a
 *  thrown last attempt → outer 502; relay a returned last attempt's Response). */
type SubscriptionAttemptOutcome =
  | { kind: 'result'; result: { response: Response; rawStatus: number | null } }
  | { kind: 'thrown'; error: unknown };

/** Run one attempt, converting a THROWN relay/network error into a
 *  `{ kind: 'thrown' }` outcome so a fetch reject becomes fallback-eligible
 *  instead of escaping to the outer 502 handler. A returned (even 5xx/429)
 *  response is `{ kind: 'result' }`. */
async function runSubscriptionAttemptOutcome(
  anthropicBody: Record<string, unknown>,
  relayBody: string,
  plan: AnthropicCallPlan,
): Promise<SubscriptionAttemptOutcome> {
  try {
    return { kind: 'result', result: await runSubscriptionAttemptWith401Retry(anthropicBody, relayBody, plan) };
  } catch (error) {
    return { kind: 'thrown', error };
  }
}

/** The `rawStatus` an outcome contributes to the advance decision: a thrown
 *  outcome maps to `null` (always fallback-eligible). */
function outcomeStatus(outcome: SubscriptionAttemptOutcome): number | null {
  return outcome.kind === 'thrown' ? null : outcome.result.rawStatus;
}

/** Surface a terminal outcome: a returned result is relayed; a thrown error is
 *  RE-THROWN so the outer `catch` in `handleAnthropicMessagesByo` writes 502. */
function settleOutcome(outcome: SubscriptionAttemptOutcome): { response: Response; rawStatus: number | null } {
  if (outcome.kind === 'thrown') throw outcome.error;
  return outcome.result;
}

/**
 * Subscription run wrapper WITH the opencodego `nextFallback` loop (D6b) — mirrors
 * the daemon `SubscriptionDispatcher`'s loop, with a NARROWER advance criterion
 * (`isFallbackEligibleStatus`: throw / 5xx / 429 only — NOT any !ok). The FIRST
 * attempt is byte-identical to the prior single-attempt behavior (verbatim
 * `rawBody` relay on the same-format path, single 401-retry). The loop ENGAGES
 * only on a TRANSIENT failure that yields a `nextFallback`:
 *  - cap = a core-local `MAX_FALLBACK_ATTEMPTS` (core cannot import the
 *    subscriptions constant);
 *  - each fallback re-resolves `upstreamUrl` + recomputes `sameFormat` + re-applies
 *    auth + RE-RESOLVES the chain for the new model (a fallback may flip go↔zen,
 *    Anthropic-shape ↔ OpenAI-shape, responses ↔ gemini ↔ chat), by rebuilding the
 *    iteration plan via `buildSubscriptionIterationPlan`;
 *  - on a FALLBACK iteration the verbatim same-format relay re-serializes a fresh
 *    per-iteration body carrying the new model, matching the dispatcher's
 *    `req.anthropicBody.model = currentModel` rewrite; the first attempt still
 *    relays the original `rawBody` byte-for-byte.
 * Each iteration is wrapped so a THROWN network/relay error becomes a
 * fallback-eligible outcome (advance to the next model) instead of escaping to the
 * outer 502 handler; only an EXHAUSTED chain surfaces the LAST outcome (re-throw a
 * thrown last attempt → 502; relay a returned last attempt's Response).
 * claude / codex / gemini omit `nextFallback` → exactly one attempt (unchanged).
 */
export async function runPipelineWithSubscriptionRetry(
  anthropicBody: Record<string, unknown>,
  rawBody: string,
  initialPlan: AnthropicCallPlan,
  route: RouteContext,
  deps: ProviderProxyDeps,
): Promise<{ response: Response; rawStatus: number | null }> {
  const profile = route.subscriptionProfile;
  const scenario = initialPlan.scenario;

  // No fallback machinery (claude/codex/gemini, or a profile without a scenario):
  // exactly one attempt, byte-identical (verbatim `rawBody` on the same-format
  // path, the parsed `anthropicBody` on the transformer path). No breaker gating
  // and `recordModelOutcome` is unset on those profiles → a pure no-op record.
  if (!profile?.nextFallback || scenario === undefined) {
    const loneOutcome = await runSubscriptionAttemptOutcome(anthropicBody, rawBody, initialPlan);
    recordBreakerOutcome(profile, initialPlan.resolvedModel, outcomeStatus(loneOutcome));
    return settleOutcome(loneOutcome);
  }

  // D2 PRIMARY-GATING (opencodego): consult the breaker for the mapped primary
  // BEFORE attempt #1. When the primary's circuit is open, advance to the first
  // admitting `nextFallback` candidate WITHOUT an upstream round-trip on the open
  // primary; when EVERY candidate is open (all-open), FAIL OPEN and attempt the
  // primary anyway (never hard-block a request on breaker state alone). When no
  // circuit is open, `allowModel(primary)` is true → the first attempt is the
  // mapped primary, byte-identical to the pre-breaker path.
  const attempted: string[] = [];
  let plan = initialPlan;
  let firstRelayBody = rawBody;
  let firstBodyObj = anthropicBody;

  if (profile.allowModel && !profile.allowModel(initialPlan.resolvedModel)) {
    // Primary open: mark it attempted (skipped, chain index 0 in the reference)
    // and pick the first admitting fallback as the real first attempt.
    attempted.push(initialPlan.resolvedModel);
    const firstAdmitting = profile.nextFallback(scenario, attempted, route.subscriptionConfig as never);
    const gatedPlan = firstAdmitting
      ? buildSubscriptionIterationPlan(profile, route, deps, firstAdmitting.modelId, initialPlan.isStream, scenario, initialPlan.sessionKey)
      : null;
    if (firstAdmitting && gatedPlan) {
      console.warn(
        `[ProviderProxy:anthropic] subscription primary ${initialPlan.resolvedModel} circuit open -> first admitting fallback ${firstAdmitting.modelId}`,
      );
      plan = gatedPlan;
      firstBodyObj = { ...anthropicBody, model: firstAdmitting.modelId };
      firstRelayBody = gatedPlan.sameFormat ? JSON.stringify(firstBodyObj) : rawBody;
    } else {
      // All circuits open (or the profile lost resolveUpstreamUrl): fail open —
      // attempt the original primary anyway. Drop it back off `attempted` so the
      // first real attempt records + (potentially) re-enters the loop normally.
      attempted.length = 0;
      console.warn(
        `[ProviderProxy:anthropic] subscription all opencodego circuits open -> fail open to primary ${initialPlan.resolvedModel}`,
      );
    }
  }

  // First real attempt (the mapped primary, the gated first-admitting fallback,
  // or the failed-open primary). Record its outcome to the breaker.
  let outcome = await runSubscriptionAttemptOutcome(firstBodyObj, firstRelayBody, plan);
  recordBreakerOutcome(profile, plan.resolvedModel, outcomeStatus(outcome));
  if (!attempted.includes(plan.resolvedModel)) attempted.push(plan.resolvedModel);

  while (attempted.length < MAX_FALLBACK_ATTEMPTS) {
    if (!isFallbackEligibleStatus(outcomeStatus(outcome))) return settleOutcome(outcome);

    const next = profile.nextFallback(scenario, attempted, route.subscriptionConfig as never);
    if (!next) return settleOutcome(outcome);

    const nextPlan = buildSubscriptionIterationPlan(
      profile,
      route,
      deps,
      next.modelId,
      plan.isStream,
      scenario,
      initialPlan.sessionKey,
    );
    if (!nextPlan) return settleOutcome(outcome); // profile lost resolveUpstreamUrl — surface last.

    const sinceLabel =
      outcome.kind === 'thrown' ? 'thrown error' : `status ${String(outcome.result.rawStatus)}`;
    console.warn(
      `[ProviderProxy:anthropic] subscription fallback ${plan.resolvedModel} -> ${next.modelId} after ${sinceLabel}`,
    );

    // FALLBACK iteration: build a per-iteration body carrying the new model (a
    // fresh shallow copy — NOT a mutation of the shared `anthropicBody` across an
    // await, which would be a race-prone pattern). The transformer path serializes
    // THIS object; the same-format relay forwards its JSON. The dispatcher's
    // `req.anthropicBody.model = currentModel` rewrite is mirrored on the copy.
    const fallbackBodyObj: Record<string, unknown> = { ...anthropicBody, model: next.modelId };
    const fallbackRelayBody = nextPlan.sameFormat ? JSON.stringify(fallbackBodyObj) : rawBody;

    plan = nextPlan;
    attempted.push(next.modelId);
    outcome = await runSubscriptionAttemptOutcome(fallbackBodyObj, fallbackRelayBody, plan);
    recordBreakerOutcome(profile, plan.resolvedModel, outcomeStatus(outcome));
  }

  // Chain exhausted (cap reached): surface the LAST attempt's outcome.
  return settleOutcome(outcome);
}

/** Core-local copy of the subscriptions `MAX_FALLBACK_ATTEMPTS` cap (core cannot
 *  import the `@omnicross/subscriptions` constant). Kept in sync with the
 *  dispatcher's `MAX_FALLBACK_ATTEMPTS_LOCAL`. */
const MAX_FALLBACK_ATTEMPTS = 3;
