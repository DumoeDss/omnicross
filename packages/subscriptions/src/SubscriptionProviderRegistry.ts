/**
 * SubscriptionProviderRegistry — fixed catalog of subscription dispatch profiles.
 *
 * Each entry maps a `SubscriptionProviderId` to a `SubscriptionDispatchProfile`
 * that tells the dispatch proxy:
 *   - how to authenticate (via the bound `AuthStrategy`),
 *   - which transformer chain to run (resolved by name from `TransformerService`),
 *   - which upstream URL to hit (static OR computed per model id),
 *   - how to map the SDK-supplied model placeholder to a provider model
 *     (OpenCodeGo scenario routing),
 *   - which fallback model entries to try when the primary fails.
 *
 * The registry is intentionally a static in-memory map — subscription
 * providers are a built-in catalog, NOT user-configurable LLM provider rows.
 */

import type { OpenCodeGoTokenConfig, SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import {
  setSubscriptionRegistryForOutbound,
  type SubscriptionRegistryLike,
} from '@omnicross/core/outbound-api/subscriptionRegistryPort';
// The dispatch-profile shapes are DEFINED in the serving core
// (`@omnicross/core/provider-proxy/types`) and re-exported here, so
// `provider-proxy/types.ts` never imports upward. The concrete
// registry below builds values of this identical shape.
import type { SubscriptionDispatchProfile } from '@omnicross/core/provider-proxy/types';
import { buildCodeAssistUrl } from '@omnicross/core/transformer/transformers/GeminiCodeAssistTransformer';

import { CircuitBreakerRegistry } from './opencodego/CircuitBreaker';
import {
  DEFAULT_OPENCODEGO_FALLBACKS,
  DEFAULT_OPENCODEGO_MODEL_MAP,
} from './opencodego/defaults';
import { buildOpenCodeGoUrl } from './opencodego/endpoints';
import {
  type OpenCodeGoShape,
  resolveOpenCodeGoHalf,
  resolveOpenCodeGoShape,
} from './opencodego/model-shape';
import { resolveOpenCodeGoScenario } from './opencodego/ScenarioRouter';
import type { SubscriptionCredentialStore } from './ports/credential-store';
import type { SubscriptionAccountService } from './SubscriptionAccountService';

/**
 * Canonical Anthropic Messages endpoint. Used ONLY by the claude profile's
 * route-to `resolveUpstreamUrl` (the Codex/Responses ingress re-encodes Unified
 * → Anthropic Messages and POSTs here). The verbatim pass-through path uses its
 * own hard-coded copy in `proxyPassThrough.ts` — kept in sync with this value.
 */
const CLAUDE_MESSAGES_UPSTREAM_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Map a resolved opencodego wire shape → the provider transformer chain that
 * re-encodes Unified → the upstream's wire (Decision 3). `anthropic` is the
 * verbatim same-format / bypass path (NO chain — both ingress paths select the
 * bypass earlier by shape), so it maps to the empty chain. The other three reuse
 * the EXISTING transformers (`opencodego` / `openai-response` / `gemini`) — no new
 * transformer module is authored.
 */
function opencodegoTransformerNamesForShape(shape: OpenCodeGoShape): readonly string[] {
  switch (shape) {
    case 'anthropic':
      return [];
    case 'responses':
      return ['openai-response'];
    case 'gemini':
      return ['gemini'];
    case 'chat':
    default:
      return ['opencodego'];
  }
}

/**
 * Resolve the `(half, shape)` for a resolved opencodego model id + opaque config.
 * The half is recovered from the user config (`resolveOpenCodeGoHalf`); the shape
 * is then `resolveOpenCodeGoShape({ provider: half, modelId })`. Shared by the
 * profile's `resolveUpstreamUrl` + `resolveProviderTransformerNames` so they agree
 * by construction.
 */
function resolveOpenCodeGoTarget(
  modelId: string,
  config: OpenCodeGoTokenConfig | undefined,
): { half: 'go' | 'zen'; shape: OpenCodeGoShape } {
  const half = resolveOpenCodeGoHalf(modelId, config);
  const shape = resolveOpenCodeGoShape({ provider: half, modelId });
  return { half, shape };
}

// Re-export the profile shapes from the core location so existing host
// consumers keep their `SubscriptionProviderRegistry`-based import paths
// unchanged.
export type {
  SubscriptionDispatchProfile,
  SubscriptionRequestSummary,
} from '@omnicross/core/provider-proxy/types';

export class SubscriptionProviderRegistry {
  private readonly profiles: Map<SubscriptionProviderId, SubscriptionDispatchProfile>;

  /**
   * Per-model circuit breaker for opencodego routing (D5). ONE registry-owned
   * process singleton, built here and captured by the opencodego profile's
   * `nextFallback` (consult) + `recordModelOutcome` (record) closures. Because
   * the `SubscriptionProviderRegistry` is itself a process singleton (via
   * `setSubscriptionProviderRegistry`), breaker state persists across requests —
   * exactly the reference's long-lived `FallbackHandler`. Constructed with the
   * default reference thresholds (3 / 30s / 3) and the default `Date.now` clock.
   */
  private readonly breaker = new CircuitBreakerRegistry();

  constructor(
    private readonly accounts: SubscriptionAccountService,
    private readonly tokens: SubscriptionCredentialStore,
  ) {
    const claude = this.accounts.getStrategy('claude');
    const codex = this.accounts.getStrategy('codex');
    const gemini = this.accounts.getStrategy('gemini');
    const opencodego = this.accounts.getStrategy('opencodego');
    if (!claude || !codex || !gemini || !opencodego) {
      throw new Error('[SubscriptionProviderRegistry] Missing strategy in SubscriptionAccountService');
    }

    this.profiles = new Map<SubscriptionProviderId, SubscriptionDispatchProfile>([
      [
        'claude',
        {
          providerId: 'claude',
          displayName: 'Claude (Anthropic OAuth)',
          authStrategy: claude,
          // The MAIN claude path stays `pass-through`: the Anthropic-ingress
          // proxy (`buildCodeCliPassThroughResult` → `handlePassThroughRequest`)
          // forwards the SDK's Anthropic body VERBATIM to `api.anthropic.com`
          // with the user's OAuth, and it NEVER reads the two fields below
          // (`resolveUpstreamUrl` / `providerTransformerNames`) — it hard-codes
          // the URL and skips the transformer chain + the AuthStrategy entirely.
          // So these fields are INERT for the pass-through path; they exist
          // SOLELY so the generalized Codex/Responses route-to plan
          // (`resolveSubscriptionChain` in `buildSubscriptionPlan`) can serve a
          // `Codex CLI → Claude subscription` route. That plan needs (a) a
          // provider transformer chain to re-encode Unified → Anthropic Messages
          // and (b) an upstream URL — both supplied here, reusing the existing
          // claude OAuth `authStrategy`. See `cliRouteResolution.ts`
          // SOUND_SUBSCRIPTION_PROVIDERS for the un-gate rationale.
          mode: 'pass-through',
          // Route-to (Responses ingress) only: Unified → Anthropic Messages.
          resolveUpstreamUrl: () => CLAUDE_MESSAGES_UPSTREAM_URL,
          providerTransformerNames: ['anthropic'],
          modelTransformerNames: [],
        },
      ],
      [
        'codex',
        {
          providerId: 'codex',
          displayName: 'Codex (ChatGPT OAuth)',
          authStrategy: codex,
          mode: 'transformer',
          // ChatGPT internal endpoint — accepts the OpenAI Responses API
          // format. Mirrors `_others/claude-relay-service/src/routes/openaiRoutes.js:454`.
          // The Codex OAuth access token grants access here; the public
          // `api.openai.com/v1/responses` endpoint would reject the same token.
          resolveUpstreamUrl: () => 'https://chatgpt.com/backend-api/codex/responses',
          providerTransformerNames: ['openai-response'],
          modelTransformerNames: [],
        },
      ],
      [
        'gemini',
        {
          providerId: 'gemini',
          displayName: 'Gemini (Google OAuth)',
          authStrategy: gemini,
          mode: 'transformer',
          // GAP CLOSED: Gemini CLI subscription tokens are minted for Google's
          // **Code Assist** endpoint (`cloudcode-pa.googleapis.com`), which
          // wraps `generateContent` in a project/session envelope and uses a
          // colon-method URL (`v1internal:generateContent`, NO `/models/<model>`
          // path — the model lives in the body). The `gemini-code-assist`
          // transformer now does that envelope work (delegating inner encoding
          // to the shared gemini utils), and the dispatch seam threads the
          // resolved Code Assist project id onto `transformerProvider.geminiProject`
          // (resolved once per account via `GeminiCodeAssistProjectResolver`).
          // `resolveUpstreamUrl` ignores the model (Code Assist has no per-model
          // path); the URL is the version-segment colon-method endpoint.
          resolveUpstreamUrl: (_model) => buildCodeAssistUrl(false),
          providerTransformerNames: ['gemini-code-assist'],
          modelTransformerNames: [],
        },
      ],
      [
        'opencodego',
        {
          providerId: 'opencodego',
          displayName: 'OpenCodeGo (Bearer key)',
          authStrategy: opencodego,
          mode: 'transformer',
          // D1 + zen: resolve the per-model `(half, shape)` from the resolved
          // model id + the opaque per-account config, then build the half-specific
          // URL honoring the half-appropriate host override (`baseUrl` for go,
          // `zenBaseUrl` for zen). The OPTIONAL `config` arg is threaded by BOTH
          // dispatch paths (the `SubscriptionDispatcher` passes its already-fetched
          // `ocConfig`; the core `/v1/messages` plan builder passes the opaque
          // `route.subscriptionConfig`). With NO zen config every resolved model
          // is go-half → byte-identical to the prior resolver.
          // `// UNVERIFIED (no live zen key)`: the zen endpoint hosts/paths are
          // ported from the reference + proven in-process only.
          resolveUpstreamUrl: (model, config) => {
            const oc = config as OpenCodeGoTokenConfig | undefined;
            const { half, shape } = resolveOpenCodeGoTarget(model, oc);
            const override = half === 'zen' ? oc?.zenBaseUrl : oc?.baseUrl;
            return buildOpenCodeGoUrl(half, shape, override);
          },
          // zen seam (Decision 3): vary the provider transformer chain by resolved
          // shape (anthropic⇒[] verbatim, chat⇒opencodego, responses⇒openai-response,
          // gemini⇒gemini). OPTIONAL on the profile type — only opencodego sets it;
          // claude/codex/gemini omit it and fall back to `providerTransformerNames`,
          // keeping their routing byte-identical. The static `providerTransformerNames`
          // below stays the go-half default both ingress paths use when this method
          // is somehow unconsulted.
          resolveProviderTransformerNames: (model, config) => {
            const { shape } = resolveOpenCodeGoTarget(model, config as OpenCodeGoTokenConfig | undefined);
            return opencodegoTransformerNamesForShape(shape);
          },
          providerTransformerNames: ['opencodego'],
          modelTransformerNames: [],
          modelMapper: (sdkModel, summary, config) => {
            const scenario = resolveOpenCodeGoScenario(summary, config);
            const entry =
              config?.modelMap?.[scenario] ??
              config?.modelMap?.default ??
              DEFAULT_OPENCODEGO_MODEL_MAP[scenario] ??
              DEFAULT_OPENCODEGO_MODEL_MAP.default;
            if (!entry) {
              // No mapping at all — leave the SDK model in place; the upstream
              // will most likely 4xx, surfacing a clear error.
              return { resolvedModel: sdkModel, scenario };
            }
            return { resolvedModel: entry.modelId, scenario };
          },
          // D2 CONSULT: skip both already-attempted models AND models whose
          // circuit is open. `breaker.allowRequest(modelId)` is the admission
          // gate — calling it has the side effect of flipping an `open` model to
          // `half-open` once its 30s window elapses AND counting a half-open admit
          // slot. It MUST therefore be consulted EXACTLY ONCE per returned model,
          // on the candidate about to be attempted — mirroring the reference
          // (`fallback.go` calls `AllowRequest` once, on the model it returns).
          // An early-returning scan (NOT `Array.filter`, which would `allowRequest`
          // every candidate and burn the admit slots of half-open models AFTER the
          // chosen one — those are never attempted, never recorded, so they would
          // wedge permanently in half-open). When NO circuit is open this returns
          // the same first non-attempted entry as the prior `!attempted` filter.
          nextFallback: (scenario, attempted, config) => {
            const list =
              config?.fallbacks?.[scenario] ??
              DEFAULT_OPENCODEGO_FALLBACKS[scenario] ??
              [];
            for (const entry of list) {
              if (attempted.includes(entry.modelId)) continue;
              // Consult the breaker ONLY for this candidate; on admit, return
              // immediately so no later candidate is consulted (admit-slot-safe).
              if (this.breaker.allowRequest(entry.modelId)) return entry;
            }
            return null;
          },
          // D2 PRIMARY-GATING: admission gate the loops consult for the PRIMARY
          // (mapped) model before attempt #1 — `nextFallback` only covers
          // fallbacks. Same side-effecting `allowRequest` semantics.
          allowModel: (modelId) => this.breaker.allowRequest(modelId),
          // D3 RECORD: the cross-path seam. Both fallback loops call this after
          // each attempt; it drives the per-model breaker. Only the opencodego
          // profile sets it — claude / codex / gemini leave it UNSET (no-op).
          recordModelOutcome: (modelId, ok) =>
            ok ? this.breaker.recordSuccess(modelId) : this.breaker.recordFailure(modelId),
        },
      ],
    ]);
  }

  /** Returns the dispatch profile for a known subscription provider, or
   *  `null` for unknown ids (callers must treat null as "fall back to the
   *  legacy LLM provider DB lookup"). */
  getProfile(providerId: string): SubscriptionDispatchProfile | null {
    return (this.profiles.get(providerId as SubscriptionProviderId) ?? null);
  }

  /** Read the currently-stored OpenCodeGo config so the proxy can pick up
   *  user overrides (modelMap / fallbacks / baseUrl). Wraps the injected
   *  `SubscriptionCredentialStore` so the proxy doesn't need to know about
   *  that surface. */
  async getOpenCodeGoConfig(): Promise<OpenCodeGoTokenConfig | undefined> {
    const full = await this.tokens.getFullConfig();
    return full.opencodego;
  }
}

let _moduleSingleton: SubscriptionProviderRegistry | null = null;

export function setSubscriptionProviderRegistry(svc: SubscriptionProviderRegistry): void {
  _moduleSingleton = svc;
  // Mirror into the serving-core outbound slot: the outbound API server
  // resolves subscription profiles through that slot WITHOUT importing this
  // package. Feeding it from this setter keeps the existing
  // `setSubscriptionProviderRegistry` test/bootstrap contract intact while
  // pointing the dependency direction DOWN (subscriptions → core).
  setSubscriptionRegistryForOutbound((svc as SubscriptionRegistryLike | null) ?? null);
}

export function getSubscriptionProviderRegistry(): SubscriptionProviderRegistry | null {
  return _moduleSingleton;
}
