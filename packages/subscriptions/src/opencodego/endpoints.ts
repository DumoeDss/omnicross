/**
 * Default OpenCodeGo upstream URLs (both provider halves).
 *
 * Ported from `_others/oc-go-cc/configs/config.example.json` +
 * `_others/oc-go-cc/internal/config/loader.go:17-25`. There are TWO halves under
 * the SAME single key:
 *   - GO  (`opencode-go`):  `https://opencode.ai/zen/go/v1/...` — chat + anthropic.
 *   - ZEN (`opencode-zen`): `https://opencode.ai/zen/v1/...`    — chat + anthropic
 *     + responses + gemini (per-model colon-method).
 *
 * The user may override each half's host independently:
 *   - `OpenCodeGoTokenConfig.baseUrl`    → GO  half  (reference `OC_GO_CC_OPENCODE_URL`).
 *   - `OpenCodeGoTokenConfig.zenBaseUrl` → ZEN half  (reference `OC_GO_CC_OPENCODE_ZEN_URL`).
 * A go-half override NEVER redirects zen traffic and vice-versa.
 */

import type { OpenCodeGoHalf, OpenCodeGoShape } from './model-shape';

// ── GO half (existing constants — byte-identical) ────────────────────────────
export const OPENCODEGO_OPENAI_SHAPE_URL = 'https://opencode.ai/zen/go/v1/chat/completions';
export const OPENCODEGO_ANTHROPIC_SHAPE_URL = 'https://opencode.ai/zen/go/v1/messages';

// ── ZEN half (NEW — mirror loader.go:22-25) ──────────────────────────────────
export const OPENCODEGO_ZEN_CHAT_URL = 'https://opencode.ai/zen/v1/chat/completions';
export const OPENCODEGO_ZEN_ANTHROPIC_URL = 'https://opencode.ai/zen/v1/messages';
export const OPENCODEGO_ZEN_RESPONSES_URL = 'https://opencode.ai/zen/v1/responses';
/**
 * The zen gemini BASE only. The per-model `/{model}:{method}` suffix is supplied
 * by the `gemini` transformer's emitted `config.url`
 * (`new URL('./${model}:${action}', base)`). The TRAILING SLASH is load-bearing:
 * `new URL('./x', '.../v1/models')` would resolve relative to `/v1/` and DROP the
 * `models` segment; `.../v1/models/` keeps it. Mirrors the reference's
 * `GeminiBaseURL + "/" + modelID` concatenation.
 */
export const OPENCODEGO_ZEN_GEMINI_BASE = 'https://opencode.ai/zen/v1/models/';

// ── Path suffixes (appended to a normalized override host) ───────────────────
export const OPENCODEGO_CHAT_PATH = '/v1/chat/completions';
export const OPENCODEGO_ANTHROPIC_PATH = '/v1/messages';
export const OPENCODEGO_RESPONSES_PATH = '/v1/responses';
/** Trailing slash (see `OPENCODEGO_ZEN_GEMINI_BASE`). */
export const OPENCODEGO_GEMINI_PATH = '/v1/models/';

/** Strip a trailing slash and `/v1[/]*` suffix from a user override host. */
export function normalizeOpenCodeGoBaseUrl(base: string): string {
  return base.replace(/\/+$/, '').replace(/\/v\d+(\/.*)?$/, '');
}

/** Default (no-override) URL constant for a given half + shape. */
function defaultUrlFor(half: OpenCodeGoHalf, shape: OpenCodeGoShape): string {
  if (half === 'zen') {
    switch (shape) {
      case 'anthropic':
        return OPENCODEGO_ZEN_ANTHROPIC_URL;
      case 'responses':
        return OPENCODEGO_ZEN_RESPONSES_URL;
      case 'gemini':
        return OPENCODEGO_ZEN_GEMINI_BASE;
      case 'chat':
      default:
        return OPENCODEGO_ZEN_CHAT_URL;
    }
  }
  // GO half only serves anthropic (minimax) + chat (everything else). A
  // responses/gemini shape can never be resolved on the go half (the go
  // classifier never returns them), but fall back to chat defensively.
  return shape === 'anthropic' ? OPENCODEGO_ANTHROPIC_SHAPE_URL : OPENCODEGO_OPENAI_SHAPE_URL;
}

/** Path suffix appended to a normalized override host for a given shape. */
function pathFor(shape: OpenCodeGoShape): string {
  switch (shape) {
    case 'anthropic':
      return OPENCODEGO_ANTHROPIC_PATH;
    case 'responses':
      return OPENCODEGO_RESPONSES_PATH;
    case 'gemini':
      return OPENCODEGO_GEMINI_PATH;
    case 'chat':
    default:
      return OPENCODEGO_CHAT_PATH;
  }
}

/**
 * Build an OpenCodeGo upstream URL for the given half + shape, honoring an
 * optional override host for THAT half. With no override the byte-identical
 * default constant is returned (go-half results are unchanged from the original
 * two-arg `buildOpenCodeGoUrl`). For the gemini shape the result is the BASE
 * ending in `/v1/models/` (trailing slash); the transformer appends
 * `{model}:{method}`.
 *
 * @param half         the provider half (`'go'` | `'zen'`).
 * @param shape        the resolved wire shape.
 * @param baseOverride the half-appropriate host override (`baseUrl` for go,
 *                     `zenBaseUrl` for zen), or undefined for the default.
 */
export function buildOpenCodeGoUrl(
  half: OpenCodeGoHalf,
  shape: OpenCodeGoShape,
  baseOverride?: string,
): string {
  if (baseOverride) {
    const base = normalizeOpenCodeGoBaseUrl(baseOverride);
    return `${base}${pathFor(shape)}`;
  }
  return defaultUrlFor(half, shape);
}
