/**
 * subscriptionSupport — single source of truth for (a) which provider ids are
 * subscription-backed and (b) which outbound endpoints can soundly serve a
 * subscription route (`outbound-api-server`, design D2 + review M1/m1).
 *
 * The subscription-id catalog mirrors `SubscriptionProviderRegistry`'s ids; the
 * static fast-path is backstopped at runtime by a live registry lookup (see
 * `isSubscriptionProviderId`) so it degrades gracefully if it drifts. Both
 * `routeResolver` and `apiServerHandlers` import from here — no duplicated set.
 *
 * @module outbound-api/subscriptionSupport
 */

import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';

import { getSubscriptionRegistryForOutbound } from './subscriptionRegistryPort';
import type { OutboundEndpoint } from './types';

/**
 * The registry-aligned subscription provider ids — the outbound layer's SSOT
 * fast-path. NOTE: `SubscriptionProviderId` is currently a `z.string()` alias,
 * so this `readonly SubscriptionProviderId[]` typing does NOT compile-enforce
 * alignment with the registry; drift is instead tolerated at runtime by
 * `isSubscriptionProviderId`'s live `registry.getProfile` fallback.
 */
export const SUBSCRIPTION_PROVIDER_IDS: readonly SubscriptionProviderId[] = [
  'claude',
  'codex',
  'gemini',
  'opencodego',
];

const SUBSCRIPTION_ID_SET: ReadonlySet<string> = new Set(SUBSCRIPTION_PROVIDER_IDS);

/**
 * True when a provider id refers to a subscription-backed provider. Checks the
 * registry-aligned static catalog first, then falls back to a live registry
 * lookup (so a registry addition is honored even before this list is updated).
 *
 * NOTE (review m2): this classifies by id string. The resolver MUST confirm the
 * id does not resolve to a real BYO provider row before treating it as
 * subscription-backed — see `routeResolver` (BYO rows win).
 */
export function isSubscriptionProviderId(providerId: string): boolean {
  if (SUBSCRIPTION_ID_SET.has(providerId)) return true;
  const registry = getSubscriptionRegistryForOutbound();
  return registry?.getProfile(providerId) != null;
}

/**
 * Which outbound endpoints can soundly serve a SUBSCRIPTION route.
 *
 * Scoped honestly to what the existing `provider-proxy` ingresses support:
 *  - `messages` (Anthropic) — the delegation reads `anthropicSdkHints.subscriptionProfile`.
 *  - `responses` (OpenAI Responses) — the ingress reads top-level
 *    `route.subscriptionProfile` (codex / opencodego / gemini route-to).
 *  - `chat` (OpenAI Chat Completions) — the chat ingress reads top-level
 *    `route.subscriptionProfile` and builds a subscription plan (openai-chat-bridge).
 *    v1 covers the CLAUDE subscription target (Unified≡OpenAI-chat → Anthropic via
 *    the profile's `['anthropic']` route-to chain, streaming + tools by reuse);
 *    the chat ingress DEFERS other subscription providers with a clear per-request
 *    error (codex/gemini/opencodego need verification / Code-Assist project
 *    handling out of this slice).
 *  - `gemini` — the gemini ingress HARD-REJECTS subscription auth (BYO-only in this
 *    slice). The Anthropic→Gemini bridge is the deferred hard part, OUT OF SCOPE.
 */
const SUBSCRIPTION_SUPPORTED_ENDPOINTS: ReadonlySet<OutboundEndpoint> = new Set<OutboundEndpoint>([
  'messages',
  'responses',
  'chat',
]);

/** True when the endpoint's ingress can soundly serve a subscription route. */
export function endpointSupportsSubscription(endpoint: OutboundEndpoint): boolean {
  return SUBSCRIPTION_SUPPORTED_ENDPOINTS.has(endpoint);
}
