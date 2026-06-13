/**
 * routeResolver — turn an endpoint's `EndpointRoutingConfig` + the detected
 * request role into a `RouteContext` for the shared `provider-proxy` dispatch
 * (`outbound-api-server`, design D2).
 *
 * Steps:
 *  1. Pick the model for the role (vision → default fallback when `visionModel`
 *     is unset; vision is optional).
 *  2. Parse the chosen `"providerId,modelId"` ref.
 *  3. Gate by `useSubscription`: OFF → only BYO-key providers are eligible
 *     (subscription-backed providers excluded); ON → subscription-backed
 *     providers are eligible.
 *  4. Resolve the provider (BYO via the `ProviderConfigSource`; subscription via the
 *     subscription registry) and build the `RouteContext` exactly as the
 *     internal callers do.
 *  5. Return a clear `503`-style error when the role's required model is unset,
 *     the provider is unavailable, or the subscription gate excludes it.
 *
 * @module outbound-api/routeResolver
 */

import type { ProviderConfigSource } from '../ports/provider-config-source';
import type {
  AnthropicSdkHints,
  IngressFormat,
  RouteContext,
  TargetProviderFormat,
} from '../provider-proxy';

import { getSubscriptionRegistryForOutbound } from './subscriptionRegistryPort';
// Shared SSOT for subscription-id classification + per-endpoint support (m1/M1).
import { endpointSupportsSubscription, isSubscriptionProviderId } from './subscriptionSupport';
import type { EndpointRoutingConfig, RequestRole } from './types';

export { isSubscriptionProviderId } from './subscriptionSupport';

/** A 503-style resolution failure. */
export interface RouteResolveError {
  status: number;
  message: string;
}

export type RouteResolveResult =
  | { ok: true; route: RouteContext; usedRole: RequestRole }
  | { ok: false; error: RouteResolveError };

/** Parse a `"providerId,modelId"` ref. Returns null on a malformed/empty ref. */
export function parseModelRef(
  ref: string | undefined,
): { providerId: string; modelId: string } | null {
  if (!ref) return null;
  const idx = ref.indexOf(',');
  if (idx <= 0) return null;
  const providerId = ref.slice(0, idx).trim();
  const modelId = ref.slice(idx + 1).trim();
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

/** Pick the role's configured model ref (with the vision→default fallback). */
function pickModelRefForRole(
  config: EndpointRoutingConfig,
  role: RequestRole,
): { ref: string | undefined; effectiveRole: RequestRole } {
  if (role === 'vision') {
    if (config.visionModel && config.visionModel.trim()) {
      return { ref: config.visionModel, effectiveRole: 'vision' };
    }
    // Vision content but no vision model → fall back to default.
    return { ref: config.defaultModel, effectiveRole: 'default' };
  }
  if (role === 'background') {
    return { ref: config.backgroundModel, effectiveRole: 'background' };
  }
  return { ref: config.defaultModel, effectiveRole: 'default' };
}

/** Resolve a route for one authenticated outbound request. */
export async function resolveRoute(args: {
  config: EndpointRoutingConfig;
  role: RequestRole;
  ingressFormat: IngressFormat;
  llmConfig: ProviderConfigSource;
  sessionId?: string | null;
}): Promise<RouteResolveResult> {
  const { config, role, ingressFormat, llmConfig } = args;
  const sessionId = args.sessionId ?? null;

  const { ref, effectiveRole } = pickModelRefForRole(config, role);
  if (!ref || !ref.trim()) {
    return {
      ok: false,
      error: {
        status: 503,
        message: `endpoint '${config.endpoint}' has no ${effectiveRole} model configured`,
      },
    };
  }

  const parsed = parseModelRef(ref);
  if (!parsed) {
    return {
      ok: false,
      error: {
        status: 503,
        message: `endpoint '${config.endpoint}' ${effectiveRole} model ref is malformed: '${ref}'`,
      },
    };
  }

  const { providerId, modelId } = parsed;

  // m2: a configured BYO provider row WINS over the subscription-id catalog.
  // Resolve the provider DB row FIRST; only when there is NO BYO row AND the id
  // is registry-classified as subscription-backed do we take the subscription
  // path. This lets a user run a BYO provider whose row id is literally
  // `gemini`/`claude` on their own key without being mis-gated.
  const provider = await llmConfig.getProvider(providerId);

  if (!provider) {
    // No BYO row. If the id is a subscription-backed provider, route via the
    // subscription gate; otherwise it is simply an unknown provider.
    if (isSubscriptionProviderId(providerId)) {
      return await resolveSubscriptionRoute({
        config,
        providerId,
        modelId,
        ingressFormat,
        sessionId,
        effectiveRole,
      });
    }
    return {
      ok: false,
      error: {
        status: 503,
        message: `provider '${providerId}' not found for endpoint '${config.endpoint}'`,
      },
    };
  }

  // BYO route — a real provider DB row backs this id.
  const isOfficialProvider = provider.isOfficial === true || provider.id === 'anthropic';
  const targetProviderFormat: TargetProviderFormat = isOfficialProvider ? 'anthropic' : 'transform';

  // For the Anthropic-messages ingress the delegated host handler needs
  // the full hint bundle (it re-auths upstream from its own apiKey, not the
  // forwarded route token). The non-Anthropic ingresses build their own plan
  // from `providerId` + `model` and ignore `anthropicSdkHints`.
  let anthropicSdkHints: AnthropicSdkHints | null = null;
  if (ingressFormat === 'anthropic-messages') {
    anthropicSdkHints = {
      apiKey: resolveApiKey(provider.api_key),
      isOfficialProvider,
      passThrough: false,
      attribution: { sessionId, apiKeyId: null },
    };
  }

  const route: RouteContext = {
    sessionId,
    targetProviderFormat,
    model: modelId,
    ingressFormat,
    authMode: 'byo',
    providerId,
    anthropicSdkHints,
  };

  return { ok: true, route, usedRole: effectiveRole };
}

/**
 * Resolve a subscription-backed route, applying BOTH gates up front so the
 * failure is a deterministic, actionable 503 (never an opaque downstream 502):
 *
 *  1. `useSubscription` must be ON for the endpoint (else "disabled").
 *  2. The endpoint's ingress must support subscription (`messages`/`responses`
 *     only). `chat`/`gemini` ingresses are BYO-only in this slice — full
 *     cross-format subscription is the deferred omnicross work, OUT OF SCOPE —
 *     so reject with a clear "not supported on this endpoint" 503 rather than
 *     letting the chat/gemini ingress hard-reject with a generic 502 (M1).
 *  3. The registry must have a dispatch profile for the provider.
 *
 * Wiring (per ingress):
 *  - `messages` (Anthropic) → the delegated host handler reads
 *    `anthropicSdkHints.subscriptionProfile` (mirrors `buildSubscriptionProxyResult`).
 *  - `responses` (OpenAI Responses) → the ingress reads the TOP-LEVEL
 *    `route.subscriptionProfile` (the `SubscriptionAuthProfile` shape, which the
 *    registry's `SubscriptionDispatchProfile` structurally satisfies), so we set
 *    it there too. `anthropicSdkHints` is ignored by that ingress.
 */
async function resolveSubscriptionRoute(args: {
  config: EndpointRoutingConfig;
  providerId: string;
  modelId: string;
  ingressFormat: IngressFormat;
  sessionId: string | null;
  effectiveRole: RequestRole;
}): Promise<RouteResolveResult> {
  const { config, providerId, modelId, ingressFormat, sessionId, effectiveRole } = args;

  // Gate 1: per-endpoint opt-in.
  if (!config.useSubscription) {
    return {
      ok: false,
      error: {
        status: 503,
        message: `subscription routing disabled for endpoint '${config.endpoint}'`,
      },
    };
  }

  // Gate 2: per-endpoint ingress support (M1 — deterministic 503, not 502).
  if (!endpointSupportsSubscription(config.endpoint)) {
    return {
      ok: false,
      error: {
        status: 503,
        message:
          `subscription routing is not supported on the '${config.endpoint}' endpoint; ` +
          `use a BYO API-key provider, or the /v1/messages or /v1/responses endpoint`,
      },
    };
  }

  // Gate 3: a dispatch profile must exist for this subscription provider.
  const registry = getSubscriptionRegistryForOutbound();
  const profile = registry?.getProfile(providerId) ?? null;
  if (!profile) {
    return {
      ok: false,
      error: {
        status: 503,
        message: `subscription provider '${providerId}' is not available`,
      },
    };
  }

  const hints: AnthropicSdkHints = {
    apiKey: '',
    isOfficialProvider: false,
    passThrough: false,
    subscriptionProfile: profile,
    attribution: { sessionId, apiKeyId: null },
  };

  // D-SEAM: pre-resolve the per-account OpenCodeGo config ONCE here (the route
  // resolver is async + already the cheap read site) and stamp it OPAQUELY onto
  // `route.subscriptionConfig`. The built-in (factory-absent) `/v1/messages` plan
  // builder passes it back into the profile closures so user `baseUrl` /
  // `modelMap` / `fallbacks` overrides apply on that path. Read ONLY for
  // opencodego (claude / codex / gemini leave it `undefined`); tolerated when the
  // registry slot doesn't implement the optional getter (BYO-only fakes). Core
  // holds this as `unknown` — it never names `OpenCodeGoTokenConfig`.
  const subscriptionConfig =
    providerId === 'opencodego' ? await registry?.getOpenCodeGoConfig?.() : undefined;

  const route: RouteContext = {
    sessionId,
    targetProviderFormat: 'transform',
    model: modelId,
    ingressFormat,
    authMode: 'subscription',
    providerId,
    // Anthropic delegation carries the dispatch profile inside
    // `anthropicSdkHints.subscriptionProfile`. The Responses ingress reads the
    // TOP-LEVEL `route.subscriptionProfile`, and so does the built-in
    // (factory-absent) `/v1/messages` subscription path (RT2.1) — the registry's
    // `SubscriptionDispatchProfile` structurally satisfies `SubscriptionAuthProfile`
    // ({ authStrategy, resolveUpstreamUrl, providerTransformerNames }), so set it
    // for BOTH. This is INERT when an Anthropic ingress factory is present: that
    // delegation reads the hint-bundle field above (and uses a different
    // route-minting path), never the top-level field. (chat/gemini never reach
    // here — Gate 2 rejected them.)
    subscriptionProfile:
      ingressFormat === 'openai-responses' || ingressFormat === 'anthropic-messages'
        ? profile
        : undefined,
    // Opaque per-account config (opencodego-only; `undefined` otherwise). Read by
    // the built-in `/v1/messages` plan builder; INERT for the factory-present
    // delegation path + non-opencodego.
    subscriptionConfig,
    anthropicSdkHints: hints,
  };

  return { ok: true, route, usedRole: effectiveRole };
}

/** Resolve an `$ENV_VAR` reference or return the literal key. */
function resolveApiKey(apiKey: string | undefined): string {
  if (!apiKey) return '';
  if (apiKey.startsWith('$')) {
    return process.env[apiKey.slice(1)] || '';
  }
  return apiKey;
}
