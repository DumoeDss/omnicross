/**
 * OpenRouter-specific serving-core helpers.
 *
 * Relocated from the host `config-service/utils.ts` (LLM serving-core
 * extraction, omnicross-phase1) so the serving core does not reach back into a
 * host module. The host `config-service/utils.ts` re-imports and re-exports
 * these from `@omnicross/core` so its own consumers are unchanged.
 */

import type { LLMProvider } from '@omnicross/contracts/llm-config';

/**
 * Check if provider is OpenRouter based on base URL
 */
export function isOpenRouterProvider(provider: LLMProvider): boolean {
  const baseUrl = (provider.api_base_url || '').toLowerCase();
  return baseUrl.includes('openrouter.ai');
}

/**
 * OpenRouter "app attribution" identity — the `HTTP-Referer` (the app's URL,
 * the primary attribution key) and `X-Title` (the app's display name) that
 * OpenRouter uses to attribute usage to an app on its public daily/weekly/
 * monthly rankings. See https://openrouter.ai/docs/app-attribution
 */
export interface OpenRouterAppIdentity {
  /** `HTTP-Referer` header — the app's URL. */
  referer: string;
  /** `X-Title` header — the app's display name on OpenRouter rankings. */
  title: string;
}

/**
 * Package default identity (omnicross). A host embedder (e.g. Elftia) overrides
 * this ONCE at boot via `setOpenRouterAppIdentity` so its own OpenRouter usage
 * is attributed under its own name instead of omnicross's.
 */
const DEFAULT_APP_IDENTITY: OpenRouterAppIdentity = {
  referer: 'https://github.com/Dumoedss/omnicross',
  title: 'Omnicross',
};

/**
 * The live OpenRouter app-attribution header set — the SINGLE source of truth
 * for every OpenRouter request the serving core makes. Both the LLM path
 * (`header-builder` / `TransformerHandler`) and the media path
 * (`completion/openrouter-headers.ts` → `buildOpenRouterHeaders`) read this
 * object. `setOpenRouterAppIdentity` mutates it in place; consumers spread it
 * at request time, so a boot-time host override is reflected everywhere without
 * re-importing.
 */
export const OPENROUTER_APP_HEADERS: Record<string, string> = {
  'HTTP-Referer': DEFAULT_APP_IDENTITY.referer,
  'X-Title': DEFAULT_APP_IDENTITY.title,
};

/**
 * Override the OpenRouter app-attribution identity. Call once at host boot,
 * before any OpenRouter request. Blank/whitespace-only fields are ignored (the
 * existing value is kept), so a partial override is safe.
 */
export function setOpenRouterAppIdentity(identity: Partial<OpenRouterAppIdentity>): void {
  const referer = identity.referer?.trim();
  const title = identity.title?.trim();
  if (referer) OPENROUTER_APP_HEADERS['HTTP-Referer'] = referer;
  if (title) OPENROUTER_APP_HEADERS['X-Title'] = title;
}

/**
 * Read the current OpenRouter app-attribution identity.
 */
export function getOpenRouterAppIdentity(): OpenRouterAppIdentity {
  return {
    referer: OPENROUTER_APP_HEADERS['HTTP-Referer'],
    title: OPENROUTER_APP_HEADERS['X-Title'],
  };
}
