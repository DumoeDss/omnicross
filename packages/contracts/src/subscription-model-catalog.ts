/**
 * subscription-model-catalog — the static model-id catalog each built-in
 * subscription provider exposes on its upstream, used to populate the
 * subscription-mode model pickers in the API Service routing editor.
 *
 * These are the model ids the upstream subscription backend actually accepts
 * (Codex → `chatgpt.com/backend-api/codex/responses`, Claude → Anthropic,
 * etc.). They are maintained by hand against the upstream catalog — same
 * convention as `outbound-api`'s `ENDPOINT_MODEL_KINDS`. The UI carries a
 * mirror pinned by test (it ships as standalone static assets with no
 * contracts runtime dep); update both in lockstep.
 *
 * Ordering is small → large within each provider (matches the editor's
 * picker render order).
 *
 * `gemini` / `opencodego` are intentionally empty for now — their upstream
 * subscription model ids are not yet confirmed; the UI disables model
 * selection for those types until they are filled in (does not block the
 * Claude/Codex paths).
 */

import type { SubscriptionProviderId } from './subscription-types';

/**
 * The model ids each subscription provider serves, small → large.
 *
 * - claude: `claude-haiku-4-5` < `claude-sonnet-5` < `claude-opus-5` < `claude-fable-5`
 * - codex:  `gpt-5.6-luna` (nano) < `gpt-5.6-terra` (mini) < `gpt-5.6-sol` (flagship)
 */
export const SUBSCRIPTION_MODEL_CATALOG: Record<SubscriptionProviderId, string[]> = {
  claude: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5'],
  codex: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
  gemini: [],
  opencodego: [],
};

/** Whether a provider has any cataloged models (drives UI model-picker gating). */
export function subscriptionProviderHasCatalog(providerId: SubscriptionProviderId): boolean {
  return SUBSCRIPTION_MODEL_CATALOG[providerId].length > 0;
}
