/**
 * subscriptionModelCatalog.ts — UI mirror of contracts'
 * `SUBSCRIPTION_MODEL_CATALOG`: the model ids each built-in subscription
 * provider serves on its upstream (small → large), used to populate the
 * subscription-mode model pickers in the routing editor.
 *
 * The `@omnicross/ui` package intentionally carries no `@omnicross/contracts`
 * runtime dependency (same convention as `endpointKinds.ts` / `types-server.ts`
 * — it ships as standalone static assets), so the catalog is re-declared here
 * and pinned by `subscriptionModelCatalog.test.ts`. If contracts' catalog
 * changes, update this mirror in lockstep.
 *
 * `gemini` / `opencodego` are empty until their upstream model ids are
 * confirmed; the editor disables model selection for those types.
 */

import type { SubscriptionProviderId } from '@/daemon/types';

/**
 * MIRROR of `@omnicross/contracts` `SUBSCRIPTION_MODEL_CATALOG` — keep in sync.
 * Ordering is small → large within each provider.
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
