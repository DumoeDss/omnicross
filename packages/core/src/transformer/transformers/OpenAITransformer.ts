/**
 * OpenAITransformer — the format-axis encoder for OpenAI Chat Completions
 * upstreams.
 *
 * This is the fourth format transformer, alongside `anthropic`, `gemini`, and
 * `openai-response`. It exists because `Unified` is OpenAI-chat-*shaped* but is
 * NOT byte-identical to the OpenAI chat wire: an endpoint decoder can attach
 * fields that only Anthropic understands, and the pipeline threads internal
 * routing state through the same object. Before this transformer the `openai`
 * format had NO encoder (`getMainTransformer` returned `null`), so every one of
 * those leaks had to be patched per-vendor — `DeepseekTransformer` and
 * `OpenCodeGoTransformer` were two copies of the same sanitizer, and every other
 * OpenAI provider got no sanitizing at all.
 *
 * ## Request (Unified → OpenAI chat wire)
 *
 * BLACKLIST, not whitelist. Only known-foreign fields are touched; everything
 * else passes through verbatim. A whitelist would silently drop the parameters
 * the chat wire legitimately carries but `UnifiedChatRequest` never declared —
 * `top_p`, `seed`, `stop`, `response_format`, `logprobs`, and in particular
 * `stream_options.include_usage`, which is the ONLY reason a chat stream emits
 * a final `usage` chunk (see `openaiChatIngress`'s usage tap). Dropping it would
 * silently zero out streaming usage for every OpenAI provider.
 *
 *  - `meta` (top level) — internal routing metadata; `UnifiedChatRequest.meta`
 *    documents that it must never be serialised.
 *  - `reasoning` (top level) — encoded as `reasoning_effort`.
 *  - `thinking` (top level) — Anthropic-shaped; the Anthropic decoder already
 *    turned the client's `thinking` into `reasoning`, so any survivor here is
 *    residue.
 *  - `cache_control` (per message, and inside text content blocks) — an
 *    Anthropic prompt-caching marker with no OpenAI-chat equivalent.
 *  - `thinking` (per message) — ENCODED, not dropped, as `reasoning_content`.
 *    Assistant turns carry prior reasoning that a reasoning upstream requires
 *    echoed back on the next tool-result turn; dropping it yields a 400
 *    ("reasoning_content must be passed back") on multi-round tool calls. The
 *    Anthropic `signature` has no chat-wire representation and is dropped.
 *
 * ## Response (OpenAI chat wire → Unified)
 *
 * Identity. On the `/v1/chat/completions` ingress the client wire IS Unified and
 * there is no endpoint transformer to re-encode, so rewriting `reasoning_content`
 * here would hand an OpenAI SDK a field it cannot read. `reasoning_content`
 * therefore stays the Unified spelling on this path, which is what the Anthropic
 * encoder (`convertOpenAIStreamToAnthropic`) already looks for.
 *
 * @module transformer/transformers/OpenAITransformer
 */

import type {
  LLMProvider,
  MessageContent,
  Transformer,
  TransformerContext,
  TransformerLogger,
  UnifiedChatRequest,
  UnifiedMessage,
} from '../types';
import { resolveRequestReasoning } from '../reasoning-effort';

/** Message-level keys that must never reach an OpenAI chat upstream. */
const FOREIGN_MESSAGE_KEYS = ['cache_control', 'thinking'] as const;

/** Top-level keys that must never reach an OpenAI chat upstream. */
const FOREIGN_BODY_KEYS = ['meta', 'reasoning', 'thinking'] as const;

/**
 * Strip Anthropic prompt-cache markers from a content block array, and collapse
 * a lone text block to a plain string (semantically identical, and some
 * OpenAI-compatible upstreams reject the single-element array form).
 * Multi-block content (text + image) keeps the array — that IS the chat wire's
 * vision shape.
 */
function normalizeContent(content: UnifiedMessage['content']): unknown {
  if (!Array.isArray(content)) return content;
  const cleaned = content.map((block) => {
    if (block && typeof block === 'object' && 'cache_control' in block) {
      const { cache_control: _dropped, ...rest } = block as MessageContent & {
        cache_control?: unknown;
      };
      return rest;
    }
    return block;
  });
  if (cleaned.length === 1) {
    const only = cleaned[0] as { type?: string; text?: string };
    if (only?.type === 'text' && typeof only.text === 'string') return only.text;
  }
  return cleaned;
}

export class OpenAITransformer implements Transformer {
  static TransformerName = 'openai';
  name = 'openai';
  endPoint = '/v1/chat/completions';
  logger?: TransformerLogger;

  /**
   * Unified → OpenAI Chat Completions.
   */
  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: LLMProvider,
    _context: TransformerContext,
  ): Promise<Record<string, unknown>> {
    const source = request as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    // Pass through every field the chat wire may legitimately carry.
    for (const key of Object.keys(source)) {
      if ((FOREIGN_BODY_KEYS as readonly string[]).includes(key)) continue;
      out[key] = source[key];
    }

    if (Array.isArray(request.messages)) {
      out.messages = request.messages.map((message) => {
        const src = message as unknown as Record<string, unknown>;
        const encoded: Record<string, unknown> = {};
        for (const key of Object.keys(src)) {
          if ((FOREIGN_MESSAGE_KEYS as readonly string[]).includes(key)) continue;
          encoded[key] = src[key];
        }
        if (message.content !== undefined) {
          encoded.content = normalizeContent(message.content);
        }
        // Anthropic thinking block → the chat wire's reasoning field. `signature`
        // is Anthropic-only and has nowhere to go.
        const thinkingContent = message.thinking?.content;
        if (typeof thinkingContent === 'string' && thinkingContent.length > 0) {
          encoded.reasoning_content = thinkingContent;
        }
        return encoded;
      });
    }

    // `reasoning` → `reasoning_effort`. 'none' means "no thinking", which the
    // chat wire spells by omitting the field entirely.
    // A native Chat field with no decoded unified reasoning is already present
    // in `out` and must remain byte/native-preserved on same-format paths.
    const reasoning = request.reasoning ? resolveRequestReasoning(request, provider) : undefined;
    if (reasoning?.effort && reasoning.effort !== 'none') {
      out.reasoning_effort = reasoning.effort;
    } else if (request.reasoning) {
      delete out.reasoning_effort;
    }

    return out;
  }

  /**
   * OpenAI Chat Completions → Unified. Identity — see the module JSDoc for why
   * `reasoning_content` is NOT rewritten here.
   */
  async transformResponseOut(
    response: Response,
    _context: TransformerContext,
  ): Promise<Response> {
    return response;
  }
}
