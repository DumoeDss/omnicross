/**
 * roleDetection — classify an outbound request's ROLE (background / default) so
 * the route resolver can pick the endpoint's model for that role
 * (`outbound-api-server`, design D2).
 *
 * Applies to the role-based endpoints (`chat`/`gemini`) only; the kind-mapped
 * endpoints (`messages`/`responses`) classify by model KIND in `kindDetection`.
 *
 * Precedence: background > default.
 *  - background  — the requested model id is in the endpoint's optional
 *                  background-model-id override list (human decision after the
 *                  proposal), OR the registry small/haiku-class name signal
 *                  matches (Claude Code's haiku probe sends exactly this).
 *  - default     — everything else.
 *
 * @module outbound-api/roleDetection
 */

import { normalizeModelId } from '@omnicross/contracts/canonical-models';

import type { IngressFormat } from '../provider-proxy';

import type { RequestRole } from './types';

/**
 * Tier TOKENS that mark a small/background-tier model across vendors. The
 * registry has no explicit "tier" column, so this conservative name signal is
 * the baseline (e.g. `claude-haiku-4-5`, `gpt-4o-mini`, `gemini-2.0-flash`).
 *
 * m5: matched at TOKEN boundaries (the id split on `-._:/ `), NOT as raw
 * substrings, so a large model whose id merely CONTAINS one of these letters
 * (e.g. a hypothetical `...-flashy-pro`, `...-lite-max-ultra`, or `nanogpt-large`)
 * is not silently misrouted to the background model. The per-endpoint
 * `backgroundModelIds` override remains the explicit escape hatch.
 */
const BACKGROUND_TIER_TOKENS = new Set([
  'haiku',
  'mini',
  'flash',
  'small',
  'lite',
  'nano',
  '8b',
]);

/**
 * Split a normalized model id into matchable tokens. Exported so `kindDetection`
 * reuses the exact same tokenizer (`/[-._:/\s]+/`) instead of re-declaring it.
 */
export function modelTokens(normalizedId: string): string[] {
  return normalizedId.split(/[-._:/\s]+/).filter(Boolean);
}

/**
 * True when the model id reads as a small/background tier — when ANY of its
 * tokens is a known tier token (token-boundary match, not substring).
 */
export function isBackgroundTierModel(rawModelId: string | undefined): boolean {
  if (!rawModelId) return false;
  const tokens = modelTokens(normalizeModelId(rawModelId));
  return tokens.some((tok) => BACKGROUND_TIER_TOKENS.has(tok));
}

/** Extract the requested model id from a parsed body, per ingress format. */
export function extractRequestedModel(
  ingressFormat: IngressFormat,
  body: Record<string, unknown>,
): string | undefined {
  // The OpenAI / Anthropic formats carry the model id under `model` on the body.
  // Gemini carries it in the URL path, so the router injects the URL-derived
  // model into `body.model` for the gemini endpoint BEFORE role detection (m4) —
  // by the time we read it here it is present for all four formats.
  const model = body['model'];
  return typeof model === 'string' && model ? model : undefined;
}

/**
 * Detect the request's role. `backgroundModelIds` is the endpoint's optional
 * override list: when an incoming requested model id matches an entry there, the
 * request is BACKGROUND regardless of the name signal; otherwise the registry
 * small/haiku-class name signal is the baseline. Precedence background > default.
 */
export function detectRequestRole(
  ingressFormat: IngressFormat,
  body: Record<string, unknown>,
  options?: { backgroundModelIds?: string[] },
): RequestRole {
  const requestedModel = extractRequestedModel(ingressFormat, body);
  if (requestedModel) {
    const overrides = options?.backgroundModelIds;
    if (overrides && overrides.length > 0) {
      const reqNorm = normalizeModelId(requestedModel);
      const inOverride = overrides.some((id) => {
        if (!id) return false;
        // Accept either a bare id or a `providerId,modelId` ref entry.
        const candidate = id.includes(',') ? id.slice(id.indexOf(',') + 1) : id;
        return normalizeModelId(candidate) === reqNorm || candidate === requestedModel;
      });
      if (inOverride) return 'background';
    }
    if (isBackgroundTierModel(requestedModel)) return 'background';
  }

  return 'default';
}

/** Map a settings endpoint id to the provider-proxy ingress format. */
export function endpointToIngressFormat(
  endpoint: 'chat' | 'responses' | 'messages' | 'gemini',
): IngressFormat {
  switch (endpoint) {
    case 'chat':
      return 'openai-chat';
    case 'responses':
      return 'openai-responses';
    case 'messages':
      return 'anthropic-messages';
    case 'gemini':
      return 'gemini-generatecontent';
  }
}
