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
  claude: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5-1'],
  codex: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-astra'],
  gemini: [],
  opencodego: [],
  kimi: ['kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3', 'kimi-for-coding', 'kimi-for-coding-highspeed'],
  grok: [
    'grok-composer-2.5-fast',
    'grok-build-0.1',
    'grok-build',
    'grok-4.5',
    'grok-4.6',
    'grok-4.3',
    'grok-4.20-0309-non-reasoning',
    'grok-4.20-0309-reasoning',
    'grok-4.20-multi-agent-0309',
  ],
  copilot: [
    'claude-haiku-4.5',
    'claude-sonnet-4.5',
    'claude-sonnet-4.6',
    'claude-opus-4.5',
    'claude-opus-4.6',
    'claude-opus-4.7',
    'claude-opus-4.8',
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-fable-5',
    'gpt-4o',
    'gpt-4.1',
    'grok-code-fast-1',
    'gemini-2.5-pro',
    'gemini-3.5-flash',
    'gemini-3-flash-preview',
    'gemini-3-pro-preview',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.1-pro-preview',
    'raptor-mini',
    'kimi-k2.7-code',
    'kimi-k3',
    'mai-code-1-flash-picker',
    'mai-code-1.1-flash',
    'gpt-5-mini',
    'gpt-5.1',
    'gpt-5.1-codex-mini',
    'gpt-5.1-codex',
    'gpt-5.1-codex-max',
    'gpt-5',
    'gpt-5.2',
    'gpt-5.2-codex',
    'gpt-5.3-codex',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.4',
    'gpt-5.5',
    'gpt-5.6-luna',
    'gpt-5.6-terra',
    'gpt-5.6-sol',
    'grok-4.5',
    'grok-4.6',
  ],
  // MIRROR of contracts' antigravity catalog (static CCA census, denylist
  // applied) — keep in lockstep.
  antigravity: [
    'tab_flash_lite_preview',
    'tab_jump_flash_lite_preview',
    'gpt-oss-120b',
    'gemini-3.1-flash-image',
    'claude-opus-4-5',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-3-flash',
    'gemini-3-pro',
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash',
    'claude-sonnet-4-5',
  ],
};

/** Whether a provider has any cataloged models (drives UI model-picker gating). */
export function subscriptionProviderHasCatalog(providerId: SubscriptionProviderId): boolean {
  return SUBSCRIPTION_MODEL_CATALOG[providerId].length > 0;
}
