/**
 * Shared contract types for the resident `ProviderProxy`.
 *
 * The `ProviderProxy` (OpenSpec `engine-provider-decouple`, design D0/D3/D7/D9)
 * is the single resident `127.0.0.1` listener that subsumes both of the
 * host's per-session proxies (Anthropic Messages ingress and OpenAI Responses
 * ingress). Per-run state lives in a `Map<token, RouteContext>`
 * minted at run start and reaped at run end / on idle TTL.
 *
 * These types are kept in their own module so the server, route map, router,
 * and the two ingress parsers can share shapes without importing one another
 * for type-only purposes.
 *
 * @module provider-proxy/types
 */

import type http from 'node:http';

import type { ThinkLevel } from '@omnicross/contracts/completion-types';
import type {
  OpenCodeGoModelEntry,
  OpenCodeGoScenario,
  OpenCodeGoTokenConfig,
  SubscriptionProviderId,
} from '@omnicross/contracts/subscription-types';
import type { UsageEngineOrigin, UsageTokens } from '@omnicross/contracts/usage-types';

import type { ApiKeyPoolService } from '../completion/ApiKeyPoolService';
import type { AuthSource } from '../pipeline/AuthSource';
import type { SubscriptionAuthProfile } from '../pipeline/SubscriptionAuthSource';
import type { AuthStrategy } from '../pipeline/SubscriptionAuthStrategy';
import type { ProviderConfigSource } from '../ports/provider-config-source';
import type { WebSearchBackend } from '../ports/web-search-backend';

// ── Proxy callback / attribution / hint shapes (E1 type de-inversion) ────────
// These generic proxy callback/attribution/hint contracts carry no host
// semantics, so they are DOWN-DEFINED here (the serving core) and re-exported
// by the host's proxy layer so its own modules keep their import paths and
// the dependency direction stays correct (host → core).

/** Callback for retry events (client toast). */
export type RetryCallback = (info: {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  statusCode: number;
  error?: string;
}) => void;

/** Callback for real-time SSE streaming events (content_block_delta, content_block_start, etc.) */
export type StreamEventCallback = (event: Record<string, unknown>) => void;

/**
 * Routing attribution carried alongside usage records — `messageId` is per-request
 * and unknown at this layer, so only the persistent `sessionId` + `apiKeyId` flow
 * through.
 */
export interface ProxyAttribution {
  sessionId?: string | null;
  apiKeyId?: string | null;
}

/**
 * 1M-context opt-in for outbound Anthropic requests. Populated by
 * the host's Claude-SDK engine from the active session's `cliBackend` /
 * `useExtendedContext` schema fields. When `enabled` is true and `model`
 * is in the 1M-capable allowlist, `injectExtendedContextBeta` adds
 * `'context-1m-2025-08-07'` to the request's `anthropic-beta` header
 * before transport.
 */
export interface ExtendedContextHint {
  enabled: boolean;
  model: string;
}

// ── Subscription dispatch profile (E3 type de-inversion) ─────────────────────
// The full structural shape of a subscription dispatch profile is down-
// defined here (using only `@omnicross/contracts` + the core `AuthStrategy`)
// and re-exported by the subscriptions registry, so `provider-proxy/types.ts`
// never imports upward. The upstream concrete profile stays IDENTICAL (it
// imports this type), keeping every consumer assignable.

/** Lightweight summary derived from the inbound Anthropic request body —
 *  consumed by `modelMapper` (scenario routing) without full body access. */
export interface SubscriptionRequestSummary {
  messageCount: number;
  /** cl100k_base-estimated token count of system + messages (no tools). */
  estimatedInputTokens: number;
  /**
   * OPTIONAL bounded per-message text slice (system prompt + the most recent
   * user/system messages, each per-message-capped) consumed ONLY by the
   * OpenCodeGo keyword matcher in `@omnicross/subscriptions`
   * (`resolveOpenCodeGoScenario`). Core only WRITES this `string[]`; it never
   * reads it and never names the matcher — keeping the cross-layer litmus at 0
   * (no `@omnicross/core` → `@omnicross/subscriptions` edge). Optional so callers
   * that omit it (legacy/tests) compile and degrade to the token-threshold +
   * `default` routing.
   */
  matchText?: string[];
}

export interface SubscriptionDispatchProfile {
  readonly providerId: SubscriptionProviderId;
  readonly displayName: string;
  readonly authStrategy: AuthStrategy;

  /** Pass-through providers (Claude) skip the transformer chain entirely.
   *  Transformer providers use the chain below + the proxy's existing
   *  `AnthropicTransformer` endpoint reverse-decoder. */
  readonly mode: 'pass-through' | 'transformer';

  /** Resolve the upstream URL for a given resolved model id. Required for
   *  `mode === 'transformer'`; unused for pass-through (proxy hard-codes
   *  `api.anthropic.com`). The OPTIONAL 2nd `config` arg lets the opencodego
   *  profile honor a per-account `baseUrl` override (D1) — additive, so existing
   *  one-arg callers compile unchanged. */
  readonly resolveUpstreamUrl?: (
    resolvedModel: string,
    config?: OpenCodeGoTokenConfig,
  ) => string;

  /** Names of transformers (registered in `TransformerService`) to run on the
   *  provider chain. The proxy adds `AnthropicTransformer` as the endpoint
   *  reverse-decoder. */
  readonly providerTransformerNames?: readonly string[];
  readonly modelTransformerNames?: readonly string[];

  /**
   * OPTIONAL shape-aware provider transformer-name resolver (opencodego zen).
   * Parallel to `resolveUpstreamUrl(model, config)`: lets a profile vary its
   * provider chain by the RESOLVED model's wire shape (e.g. zen `responses` ⇒
   * `['openai-response']`, `gemini` ⇒ `['gemini']`). `config` is `unknown` on the
   * core side (opaque-config discipline — core never names
   * `OpenCodeGoTokenConfig` from `@omnicross/subscriptions`); the subscriptions
   * implementation narrows it. When ABSENT, both ingress paths fall back to the
   * static `providerTransformerNames` — BYTE-IDENTICAL for claude / codex / gemini
   * (which leave this unset). Purely additive (optional).
   */
  readonly resolveProviderTransformerNames?: (
    model: string,
    config?: unknown,
  ) => readonly string[];

  /** Optional model placeholder rewriter — only set for OpenCodeGo. */
  readonly modelMapper?: (
    sdkModel: string,
    summary: SubscriptionRequestSummary,
    config: OpenCodeGoTokenConfig | undefined,
  ) => { resolvedModel: string; scenario: OpenCodeGoScenario };

  /** Optional fallback resolver — for OpenCodeGo, picks the next model after
   *  an unrecoverable error. Returns `null` when exhausted. Cap = 3. The
   *  opencodego implementation ALSO consults the circuit breaker (D5): it skips
   *  models whose circuit is open. */
  readonly nextFallback?: (
    scenario: OpenCodeGoScenario,
    attempted: readonly string[],
    config: OpenCodeGoTokenConfig | undefined,
  ) => OpenCodeGoModelEntry | null;

  /** Optional circuit-breaker admission gate for the PRIMARY (mapped) model
   *  (D5 primary-gating). Only set for OpenCodeGo. Returns whether `modelId`'s
   *  circuit currently admits a request (side-effecting: flips an `open` model
   *  to `half-open` once its window elapses, exactly like `nextFallback`'s
   *  internal consult). `nextFallback` covers the FALLBACKS; this covers the
   *  primary the loop already holds. Absent/undefined ⇒ the loop treats the
   *  primary as always admitted (claude / codex / gemini have no breaker). */
  readonly allowModel?: (modelId: string) => boolean;

  /** Optional record-outcome callback (D5 record seam). Only set for OpenCodeGo.
   *  Both fallback loops invoke it after each attempt: `ok: true` on a `2xx`,
   *  `ok: false` on a thrown/network error / `5xx` / `429`; a non-429 `4xx` is
   *  NEUTRAL and the loops MUST NOT call it. Drives the per-model breaker.
   *  Absent/undefined for claude / codex / gemini ⇒ a no-op (no breaker). */
  readonly recordModelOutcome?: (modelId: string, ok: boolean) => void;
}

// ── Anthropic ingress handler port (E1 value de-inversion) ───────────────────
// The Anthropic `/v1/messages` ingress DELEGATES wholesale to the per-request
// handler built by the host's request-handler factory.
// Instead of importing that factory UP into the host, the ingress calls an
// injected factory threaded through `ProviderProxyDeps`. Bootstrap supplies
// the host's factory (whose return type is structurally an
// `AnthropicIngressHandler`).

/** The single-entry handler the Anthropic ingress drives per request. */
export interface AnthropicIngressHandler {
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
}

/**
 * Per-run inputs the resident proxy threads into the ingress handler factory.
 * Structural mirror of the host's `RouteHandlerParams` — kept here so the
 * ingress + `ProviderProxyDeps` do not import upward. The host's
 * `RouteHandlerParams` re-exports / aligns to this shape (so its
 * request-handler factory is assignable to the factory type below).
 */
export interface AnthropicRouteHandlerParams {
  readonly llmConfig: ProviderConfigSource;
  readonly providerId: string;
  readonly model: string;
  readonly apiKey: string;
  readonly backgroundTaskModel?: string;
  readonly isOfficialProvider: boolean;
  readonly thinkingLevel?: ThinkLevel;
  readonly extendedContext?: ExtendedContextHint | null;
  readonly passThrough: boolean;
  /** Upstream Bearer for the pass-through path (resident-proxy route token swap). */
  readonly passThroughAuthToken?: string | null;
  /** Lazy per-request resolver for the pass-through Bearer (takes precedence over the static one). */
  readonly resolvePassThroughAuthToken?: (() => Promise<string | null>) | null;
  readonly subscriptionProfile?: SubscriptionDispatchProfile | null;
  readonly maxConcurrency?: number;
  /** Instance-level web-search backend; falls back to the proxy-global one. */
  readonly webSearchService?: WebSearchBackend | null;
  readonly onRetry?: RetryCallback;
  readonly onStreamEvent?: StreamEventCallback;
  readonly usageRecorder?: UsageRecorderImport | null;
  readonly attribution?: ProxyAttribution | null;
}

/** Factory that builds a per-request Anthropic ingress handler. */
export type AnthropicIngressHandlerFactory = (
  params: AnthropicRouteHandlerParams,
) => AnthropicIngressHandler;

/**
 * Wire format the proxy ingests for a given route. Phase 1 landed the two
 * already-sound parsers (`anthropic-messages`, `openai-responses`);
 * `provider-proxy-transformer-matrix` adds `openai-chat` (qwen / copilot /
 * opencode) and `gemini-generatecontent` (gemini-CLI api-key/relay) — completing
 * the resident proxy's 4-ingress-parser matrix.
 */
export type IngressFormat =
  | 'anthropic-messages'
  | 'openai-responses'
  | 'openai-chat'
  | 'gemini-generatecontent';

/**
 * The target Provider's wire format. The proxy's internal pass-through-vs-
 * transform decision is keyed on `(ingressFormat, targetProviderFormat)`:
 * when they MATCH the request is passed through + re-authed; otherwise it is
 * transformed through the Unified chain (design D3).
 *
 * NOTE: `'anthropic'` here is the FORMAT family, not a provider id. An official
 * or third-party Anthropic Messages provider is `'anthropic'`; an
 * OpenAI-compatible / Responses provider is `'openai-responses'`.
 */
export type TargetProviderFormat = 'anthropic' | 'openai-responses' | 'transform';

/**
 * How the proxy re-authenticates a route upstream. `'byo'` resolves the key
 * from an LLM-config provider row (with optional `ApiKeyPool` failover);
 * `'subscription'` re-auths via a subscription `AuthStrategy` (OAuth bearer +
 * 401 refresh). The forwarded route-token sentinel is ALWAYS discarded — the
 * proxy never trusts the CLI/SDK-carried key.
 */
export type RouteAuthMode = 'byo' | 'subscription';

/**
 * The Anthropic SDK-hint bundle carried on a `RouteContext` for routes whose
 * ingress is `'anthropic-messages'`. The Anthropic path is NOT re-implemented
 * inside the resident proxy — it is DELEGATED wholesale to the host's existing
 * per-request proxy handler (engine-provider-decouple task 2.10, "delegate for
 * parity"). That handler keeps owning its own upstream fetch + all the SDK
 * quirks (probe-mock, local web-search interception, thinkingLevel / 1M-context
 * beta injection, subscription dispatch, and the 5h/7d window header taps) — so
 * everything the host proxy used to receive per session is threaded here per
 * run and fed straight into the per-request handler factory.
 *
 * D7 conversion-SSOT is ALREADY MET: the delegated host handler runs
 * its Anthropic⇄Unified⇄provider conversion through the SAME shared pipeline
 * SSOT (`executeProviderCall` + `AnthropicTransformer`) that the Responses /
 * OpenAI-Chat / Gemini ingresses use — there is no second conversion stack. The
 * SDK quirks listed above (probe / web-search / thinking / window-tap) are
 * INGRESS concerns and deliberately stay at the ingress under the design's
 * ingress-vs-core split; they are NOT folded into the shared core.
 */
export interface AnthropicSdkHints {
  /** Real provider key (resolved at run start) for `getProviderHeaders`. */
  readonly apiKey: string;
  /** Official-Anthropic provider → skip probe caching + transformer pipeline. */
  readonly isOfficialProvider: boolean;
  /** claude-code OAuth pass-through (forward to api.anthropic.com verbatim). */
  readonly passThrough: boolean;
  /**
   * Host-managed OAuth Bearer token for the pass-through path. With the
   * resident proxy the SDK forwards the route TOKEN as its `Authorization`
   * header (used only for route lookup, then discarded), so the real upstream
   * Bearer can no longer ride the SDK header — it is carried here and
   * re-applied by the pass-through forwarder. `null`/absent → fall back to the
   * SDK's own forwarded credential (system `~/.claude/.credentials.json`).
   */
  readonly passThroughAuthToken?: string | null;
  /**
   * OPTIONAL lazy resolver for the pass-through upstream Bearer, evaluated at
   * REQUEST time rather than route-build time. When present it takes precedence
   * over the static `passThroughAuthToken`, so a long-lived route always forwards
   * a freshly auto-refreshed token (the host re-reads its OAuth store / system
   * credentials per request) instead of the one captured when the route was
   * built — that capture is what makes a session outlive its token and 401
   * mid-run. Returns `null` (or throws) to fall back to the static token.
   */
  readonly resolvePassThroughAuthToken?: (() => Promise<string | null>) | null;
  /** User thinking-budget preference (Anthropic-direct + reasoning chain). */
  readonly thinkingLevel?: ThinkLevel;
  /** 1M-context opt-in (injects `context-1m-2025-08-07` into anthropic_beta). */
  readonly extendedContext?: ExtendedContextHint | null;
  /** Subscription dispatch profile (Codex/Gemini/OpenCodeGo over the SDK wire). */
  readonly subscriptionProfile?: SubscriptionDispatchProfile | null;
  /** Per-request max-concurrency cap for the error-handler semaphore. */
  readonly maxConcurrency?: number;
  /** Instance-level web-search backend (falls back to the proxy-global one). */
  readonly webSearchService?: WebSearchBackend | null;
  /** Retry-event callback (client toast). */
  readonly onRetry?: RetryCallback;
  /** Real-time SSE event callback (client live-display). */
  readonly onStreamEvent?: StreamEventCallback;
  /** Usage attribution (sessionId + apiKeyId) for recorded usage rows. */
  readonly attribution?: ProxyAttribution | null;
  /**
   * The usage recorder (`UsageRecorderImport` port) for the delegated
   * stream-manager taps (stream + non-stream + 5h/7d window). Per-run
   * because `buildProviderEnvWithProxy` resolves it from the explicit arg ??
   * the module-level recorder, exactly as the host proxy received it. The
   * host injects its concrete usage-recorder service, which satisfies the port.
   */
  readonly usageRecorder?: UsageRecorderImport | null;
}

/**
 * Per-run routing context, looked up by the crypto route token carried in the
 * forwarded `Authorization` sentinel. Shaped to exactly what the pipeline call
 * (`executeProviderCall` + the `endpointTransformer` seam) needs to re-auth and
 * route a single run's traffic. There is NO fallback: a token miss or an
 * expired entry is rejected (design D9).
 */
export interface RouteContext {
  /** Owning chat session id — usage attribution + ApiKeyPool affinity. */
  readonly sessionId: string | null;
  /**
   * Target Provider's wire format. Drives the internal pass-through-vs-transform
   * decision against the route's `ingressFormat`.
   */
  readonly targetProviderFormat: TargetProviderFormat;
  /** Resolved provider model the upstream request targets. */
  readonly model: string;
  /** Wire format this route's ingress decodes. */
  readonly ingressFormat: IngressFormat;
  /** Re-auth mode (BYO key vs subscription OAuth). */
  readonly authMode: RouteAuthMode;
  /**
   * LLM-config provider row id whose key/headers authenticate a BYO call.
   * Required for `authMode === 'byo'`; ignored for subscription routes.
   */
  readonly providerId?: string;
  /**
   * Background-task model (the SDK's haiku probes map to this). Optional —
   * falls back to `model` when omitted. Anthropic ingress quirk only.
   */
  readonly backgroundTaskModel?: string;
  /**
   * Pre-built `AuthSource` for this route, when the caller resolved it at run
   * start (subscription routes supply this). When omitted for BYO routes the
   * proxy builds an `LlmConfigProviderAuth` from `providerId` at request time.
   */
  readonly auth?: AuthSource;
  /**
   * Subscription profile (structural `SubscriptionAuthProfile` subset — the
   * registry's full `SubscriptionDispatchProfile` satisfies it). REQUIRED when
   * `authMode === 'subscription'`. The route resolver populates it for BOTH the
   * OpenAI-Responses ingress and the built-in (factory-absent) Anthropic
   * `/v1/messages` ingress (RT2.1). The Responses ingress consumes only
   * `authStrategy` / `resolveUpstreamUrl` / `providerTransformerNames`; the
   * built-in messages subscription path additionally reads the OPTIONAL `mode`
   * + `modelMapper` fields (present on the registry profile passed here). The
   * factory-present Anthropic delegation carries its OWN profile inside
   * `anthropicSdkHints.subscriptionProfile` and ignores this field.
   */
  readonly subscriptionProfile?: SubscriptionAuthProfile | null;
  /**
   * OPAQUE per-account subscription config (opencodego-only). Populated by the
   * route resolver from the subscription registry's `getOpenCodeGoConfig()`
   * getter; passed BACK INTO the profile closures (`modelMapper` /
   * `nextFallback` / `resolveUpstreamUrl`) by the built-in (factory-absent)
   * `/v1/messages` plan builder so user `baseUrl` / `modelMap` / `fallbacks`
   * overrides apply on that path.
   *
   * Typed `unknown` ON PURPOSE: core MUST NOT name the concrete
   * `OpenCodeGoTokenConfig` type from `@omnicross/subscriptions` (cross-layer
   * litmus = 0). The plan builder narrows it to the contract type
   * (`@omnicross/contracts`) at the single profile-call boundary.
   *
   * INERT when an Anthropic ingress factory is injected (the built-in plan
   * builder is then unreachable) and for non-opencodego routes (claude /
   * codex / gemini leave it `undefined`).
   */
  readonly subscriptionConfig?: unknown;
  /**
   * The Anthropic SDK-hint bundle. REQUIRED when
   * `ingressFormat === 'anthropic-messages'` (the resident proxy delegates that
   * ingress to the host's existing per-request handler, which needs the full bundle).
   * Ignored for the OpenAI Responses ingress.
   */
  readonly anthropicSdkHints?: AnthropicSdkHints | null;
}

/**
 * App-session-scoped dependencies the resident proxy needs to service ALL
 * routes. Unlike the per-run proxies these are wired ONCE at startup; per-run
 * state lives in the route map.
 */
export interface ProviderProxyDeps {
  readonly llmConfig: ProviderConfigSource;
  /**
   * Session-affine key selection + 429/529/401/403 failover. Centralized here
   * (task 2.8) so the next-batch cutover removes the per-proxy taps. Optional —
   * BYO single-key routes work without it.
   */
  readonly apiKeyPool?: ApiKeyPoolService | null;
  /**
   * The single usage tap (task 2.8). When set, both ingress relays
   * record their non-stream usage through it. Optional.
   */
  readonly usageRecorder?: UsageRecorderImport | null;
  /**
   * Factory for the per-request Anthropic `/v1/messages` ingress handler
   * (E1 de-inversion). The ingress builds its delegated request handler
   * through THIS injected factory instead of importing the host's factory
   * directly. Bootstrap supplies the host implementation.
   *
   * Optional so unit-test constructors that never drive the Anthropic ingress
   * (env-wiring smoke, pool failover, etc.) compile unchanged; when a route
   * with `ingressFormat: 'anthropic-messages'` IS served without it wired, the
   * ingress responds 502 (the factory is a hard dependency of THAT path only).
   */
  readonly anthropicIngressHandlerFactory?: AnthropicIngressHandlerFactory | null;
}

/**
 * Structural port for the usage recorder — only the `record` method.
 *
 * Kept structural so the serving core does not depend on the host's concrete
 * usage-recorder class. The host injects that concrete service at
 * bootstrap; it satisfies this port. Both the proxy taps (narrow literal-null
 * payloads) and the CompletionService / TransformerHandler completion path
 * (rich payloads with `messageId` / `apiKeyId` / `'completion'` origin) call
 * through this single `record()`, so the accepted input is the full structural
 * mirror of the host's `UsageRecordInput`.
 */
export interface UsageRecorderImport {
  record(input: UsageRecordImportInput): void;
}

/**
 * The usage payload accepted by the recorder port — structural mirror of the
 * host's `UsageRecordInput` (type-only; no host import). Covers both the proxy
 * taps and the completion path.
 */
export interface UsageRecordImportInput {
  messageId?: string | null;
  parentMessageId?: string | null;
  sessionId?: string | null;
  providerId: string;
  model: string;
  apiKeyId?: string | null;
  engineOrigin: UsageEngineOrigin;
  usage: UsageTokens;
  rawUsage?: unknown;
  runId?: string | null;
  eventId?: string | null;
}
