/**
 * GitHub Copilot model-wire map — which of the catalog's three wires each
 * served model rides, and the per-wire upstream path + provider transformer
 * chain. Verified ids/wires from the audit source's frozen census; models are
 * grouped by wire exactly as `SUBSCRIPTION_MODEL_CATALOG.copilot` lists them.
 *
 * The three faces live on ONE host (the Copilot API base):
 *  - anthropic-messages → `/v1/messages`   (Claude family; same-format relay
 *    for Anthropic-shape clients — the URL suffix is what the core plan
 *    builder keys same-format detection on)
 *  - openai-responses    → `/v1/responses`
 *  - openai chat         → `/v1/chat/completions`
 *
 * @module @omnicross/subscriptions/copilot/models
 */

/** The three Copilot wire shapes. */
export type CopilotWire = 'anthropic' | 'responses' | 'chat';

const WIRES: Record<CopilotWire, ReadonlySet<string>> = {
  anthropic: new Set([
    'claude-haiku-4.5',
    'claude-sonnet-4',
    'claude-sonnet-4.5',
    'claude-sonnet-4.6',
    'claude-sonnet-5',
    'claude-opus-4.5',
    'claude-opus-4.6',
    'claude-opus-4.7',
    'claude-opus-4.8',
    'claude-opus-5',
    'claude-fable-5',
  ]),
  chat: new Set([
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
  ]),
  responses: new Set([
    'gpt-5',
    'gpt-5-mini',
    'gpt-5.1',
    'gpt-5.1-codex',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex-mini',
    'gpt-5.2',
    'gpt-5.2-codex',
    'gpt-5.3-codex',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.5',
    'gpt-5.6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'grok-4.5',
    'grok-4.6',
    'mai-code-1-flash-picker',
    'mai-code-1.1-flash',
  ]),
};

/** Classify a resolved model id; UNKNOWN ids fall to the responses wire (the
 *  newest models land there first). */
export function copilotWireFor(modelId: string): CopilotWire {
  if (WIRES.anthropic.has(modelId)) return 'anthropic';
  if (WIRES.chat.has(modelId)) return 'chat';
  return 'responses';
}

/** The per-wire upstream PATH under the Copilot API base. */
export function copilotPathFor(wire: CopilotWire): string {
  if (wire === 'anthropic') return '/v1/messages';
  if (wire === 'chat') return '/v1/chat/completions';
  return '/v1/responses';
}

/** The per-wire provider transformer chain (mirrors the opencodego shape seam). */
export function copilotTransformerNamesForWire(wire: CopilotWire): readonly string[] {
  if (wire === 'anthropic') return ['anthropic'];
  if (wire === 'chat') return ['openai'];
  return ['openai-response'];
}

/** Every known wire model id (the login-time policy-enable sweep uses this). */
export function copilotWireModelIds(): readonly string[] {
  return [...WIRES.anthropic, ...WIRES.chat, ...WIRES.responses];
}

/** Resolve the account-effective Copilot API base (discovered endpoint wins). */
export function copilotBaseUrl(config: { apiEndpoint?: string; enterpriseUrl?: string } | undefined): string {
  const endpoint = config?.apiEndpoint?.trim();
  if (endpoint) return endpoint.replace(/\/+$/, '');
  const enterprise = config?.enterpriseUrl?.trim().toLowerCase();
  if (enterprise) {
    const host = enterprise.startsWith('copilot-api.') ? enterprise : `copilot-api.${enterprise}`;
    return `https://${host}`;
  }
  return 'https://api.githubcopilot.com';
}
