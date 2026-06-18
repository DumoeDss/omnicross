/**
 * OpenRouter request header / endpoint helpers.
 *
 * Shared by the multimodal subsystems (image / music / video / asr / tts) that
 * route through OpenRouter. The app-attribution headers (`HTTP-Referer` /
 * `X-Title`) come from the single shared `OPENROUTER_APP_HEADERS` identity in
 * `../openrouter` — the SAME source the LLM `header-builder` path uses — so a
 * host embedder's boot-time `setOpenRouterAppIdentity` override is honored here
 * too. This helper exists so media services don't need the LLM provider type.
 */

import { OPENROUTER_APP_HEADERS } from '../openrouter';

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterCredentialFields {
  apiKey?: string;
  endpoint?: string;
}

export interface OpenRouterHeaderOptions {
  /** Defaults to `application/json`. Pass `false` to omit. */
  contentType?: string | false;
  /** Extra headers to merge after the standard set. */
  extra?: Record<string, string>;
}

/**
 * Build the standard OpenRouter request header set from a credential record.
 * Throws when `apiKey` is missing — every OpenRouter request requires one.
 * `HTTP-Referer` and `X-Title` come from the shared app-attribution identity
 * (`OPENROUTER_APP_HEADERS`), overridable once at host boot via
 * `setOpenRouterAppIdentity`.
 */
export function buildOpenRouterHeaders(
  credentials: OpenRouterCredentialFields,
  options: OpenRouterHeaderOptions = {}
): Record<string, string> {
  const apiKey = credentials.apiKey?.trim();
  if (!apiKey) {
    throw new Error('OpenRouter API key is required');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    ...OPENROUTER_APP_HEADERS,
  };

  if (options.contentType !== false) {
    headers['Content-Type'] = options.contentType ?? 'application/json';
  }

  if (options.extra) {
    for (const [key, value] of Object.entries(options.extra)) {
      headers[key] = value;
    }
  }

  return headers;
}

/**
 * Resolve the OpenRouter base URL from the provider's `endpoint` config,
 * falling back to the default. The returned value never has a trailing slash.
 */
export function resolveOpenRouterBaseUrl(endpoint?: string | null): string {
  const raw = endpoint?.trim();
  const base = raw && raw.length > 0 ? raw : OPENROUTER_DEFAULT_BASE_URL;
  return base.replace(/\/+$/, '');
}

/**
 * Join the OpenRouter base URL with a sub-path. Leading slashes on the path
 * are tolerated.
 */
export function buildOpenRouterUrl(endpoint: string | undefined, path: string): string {
  const base = resolveOpenRouterBaseUrl(endpoint);
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${cleanPath}`;
}
