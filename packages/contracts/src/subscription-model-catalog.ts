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
 * - codex:  `gpt-5.6-luna` (nano) < `gpt-5.6-terra` (mini) < `gpt-5.6-sol` (flagship) < `gpt-6-astra`
 */
export const SUBSCRIPTION_MODEL_CATALOG: Record<SubscriptionProviderId, string[]> = {
  claude: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5'],
  codex: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-astra'],
  gemini: [],
  opencodego: [],
  // Kimi Code's subscription catalog (the official CLI's built-ins + the
  // k2.6/k2.7-code coding models, small → large).
  kimi: ['kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3', 'kimi-for-coding', 'kimi-for-coding-highspeed'],
  // SuperGrok's Responses-wire catalog (verified ids from the audit source,
  // small → large; the grok-build / composer models are plan-gated products).
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
  // GitHub Copilot's mixed-wire catalog (verified ids from the audit source,
  // grouped by wire then small → large). The per-model wire each id rides is
  // mapped in `@omnicross/subscriptions`' copilot module (this list only feeds
  // the picker).
  copilot: [
    // anthropic-messages face (Claude family)
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
    // openai-chat face
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
    // openai-responses face
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
};

/** Whether a provider has any cataloged models (drives UI model-picker gating). */
export function subscriptionProviderHasCatalog(providerId: SubscriptionProviderId): boolean {
  return SUBSCRIPTION_MODEL_CATALOG[providerId].length > 0;
}
