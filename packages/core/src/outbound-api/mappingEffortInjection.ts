/**
 * mappingEffortInjection — stamp a mapping-pinned default thinking level onto
 * a parsed request body, in the INGRESS wire's own native field.
 *
 * Downstream-route model mappings may pin an effort (`gpt-5.6-sol-xhigh` →
 * `gpt-5.6-sol` @ xhigh) for clients that cannot express one on the wire. The
 * outbound router applies it at ONE seam — after route resolution, before the
 * replayed body is dispatched — so every downstream path (same-format verbatim
 * relays, transformer chains, subscription fallback copies) sees a body
 * byte-equivalent to one a client expressing the intent natively would have
 * sent. Capability negotiation therefore stays exactly where it already lives
 * (the transformer-chain reasoning encoders).
 *
 * Client-first semantics: the default is injected ONLY when the request body
 * carries no reasoning intent of its own. A client-sent effort/thinking always
 * wins, and a mapping without `effort` never touches the body.
 *
 * @module outbound-api/mappingEffortInjection
 */

import { extractReasoningIntent } from '../reasoning/reasoning-plan';
import type { GatewayMappingEffort, OutboundEndpoint } from './types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a parsed OpenAI-shaped body (chat ≡ Unified, Responses) carries any
 * reasoning intent — a recognized unified `reasoning` object or a native
 * `reasoning_effort`. `extractReasoningIntent` reads exactly these fields.
 */
function hasOpenAiWireReasoningIntent(body: Record<string, unknown>): boolean {
  return extractReasoningIntent({
    model: typeof body['model'] === 'string' ? body['model'] : '',
    reasoning: isPlainObject(body['reasoning']) ? body['reasoning'] : undefined,
    reasoning_effort: body['reasoning_effort'],
  }) !== undefined;
}

/**
 * Mutate `body` in place with the wire-native encoding of `effort` when the
 * client expressed no reasoning intent. Returns whether anything was written —
 * the caller re-serializes the replayed body ONLY then (no effort, client
 * intent present, or a no-op level ⇒ byte-identical replay).
 *
 * A CUSTOM (non-canonical) effort is written verbatim: same-format paths pass
 * it upstream unchanged (the escape hatch for levels our presets don't know);
 * cross-format negotiation does not recognize it and drops the injected
 * thinking instead of guessing.
 */
export function injectMappingEffortDefault(
  endpoint: OutboundEndpoint,
  effort: GatewayMappingEffort | undefined,
  body: Record<string, unknown>,
): boolean {
  if (!effort) return false;

  switch (endpoint) {
    case 'chat':
      // The chat wire ≡ Unified: a recognized `reasoning` object or a native
      // `reasoning_effort` both count as client intent.
      if (hasOpenAiWireReasoningIntent(body)) {
        return false;
      }
      body['reasoning_effort'] = effort;
      return true;

    case 'responses': {
      // The Responses wire spells the same intent `reasoning: { effort, … }`;
      // sibling keys (`summary`) are preserved, a bare effort is added.
      if (hasOpenAiWireReasoningIntent(body)) {
        return false;
      }
      const reasoning = body['reasoning'];
      body['reasoning'] = {
        ...(isPlainObject(reasoning) ? reasoning : {}),
        effort,
      };
      return true;
    }

    case 'messages': {
      // The Anthropic wire carries budgets or adaptive thinking in `thinking`.
      // Any present value (enabled/adaptive/disabled) is client intent.
      if (body['thinking'] !== undefined) return false;
      // 'none' means "do not ask for thinking" — an absent `thinking` field
      // already IS that state, so there is nothing to write.
      if (effort === 'none') return false;
      body['thinking'] = { type: 'adaptive' };
      const outputConfig = body['output_config'];
      body['output_config'] = {
        ...(isPlainObject(outputConfig) ? outputConfig : {}),
        effort,
      };
      return true;
    }

    case 'gemini': {
      // The Gemini wire nests the intent under
      // `generationConfig.thinkingConfig` (discrete `thinkingLevel` or a
      // `thinkingBudget`). The decode→re-encode round trip downstream
      // negotiates the level against the target model's capabilities.
      const generationConfig = body['generationConfig'];
      const config = isPlainObject(generationConfig) ? generationConfig : {};
      if (config['thinkingConfig'] !== undefined) return false;
      body['generationConfig'] = {
        ...config,
        thinkingConfig: { thinkingLevel: effort },
      };
      return true;
    }
  }
}
