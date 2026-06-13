/**
 * OpenCodeGoTransformer — minimal request/response normalizer for OpenCodeGo's
 * OpenAI-shape `/v1/chat/completions` upstream.
 *
 * The internal `UnifiedChatRequest` is already OpenAI-shape, so most of the
 * conversion work happens upstream of this transformer (AnthropicTransformer
 * decodes the SDK's Anthropic body to Unified at the chain's endpoint). This
 * transformer's job is to:
 *
 *   - Drop `meta` (internal routing metadata) before serializing.
 *   - Normalize `messages[].content` from `Array<MessageContent>` to a plain
 *     string when it's a single text block — some OpenCodeGo models reject
 *     the array form.
 *   - Drop fields the upstream rejects (e.g. `reasoning` when the model
 *     isn't a thinking model).
 *
 * **MiniMax models route to the Anthropic-shape `/v1/messages` upstream
 * BYPASSING this transformer entirely** — see the dispatch proxy's
 * subscription branch and `model-shape.ts`.
 *
 * @module transformer/transformers/OpenCodeGoTransformer
 */

import type {
  LLMProvider,
  Transformer,
  TransformerContext,
  TransformerLogger,
  UnifiedChatRequest,
} from '../types';

export class OpenCodeGoTransformer implements Transformer {
  static TransformerName = 'opencodego';
  name = 'opencodego';
  endPoint = '/v1/chat/completions';
  logger?: TransformerLogger;

  async auth(
    request: unknown,
    _provider: LLMProvider,
    _context: TransformerContext,
  ): Promise<{ body: unknown; config: { headers: Record<string, string | undefined> } }> {
    // Subscription-mode dispatch applies headers via `AuthStrategy.applyHeaders`
    // in the dispatch proxy; here we just leave Authorization to the proxy
    // layer (`AUTH_HEADER_KEYS` in the proxy strips any auth header
    // the chain returns).
    return { body: request, config: { headers: {} } };
  }

  /**
   * Unified → OpenAI Chat Completions.
   * Unified IS chat completions shape; this is mostly stripping `meta` and
   * normalizing string-content single-block messages.
   */
  async transformRequestIn(
    request: UnifiedChatRequest,
    _provider: LLMProvider,
    _context: TransformerContext,
  ): Promise<Record<string, unknown>> {
    const messages = request.messages.map((m) => {
      const content = m.content;
      // Single-text-block content → string. Multi-block (image + text) stays
      // as array since OpenCodeGo OpenAI-shape upstreams accept the array form.
      if (Array.isArray(content) && content.length === 1 && content[0]?.type === 'text') {
        return { ...m, content: (content[0] as { type: 'text'; text: string }).text };
      }
      return m;
    });

    const out: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: request.stream,
    };
    if (request.temperature !== undefined) out.temperature = request.temperature;
    if (request.max_tokens !== undefined) out.max_tokens = request.max_tokens;
    if (request.tools && request.tools.length > 0) out.tools = request.tools;
    if (request.tool_choice !== undefined) out.tool_choice = request.tool_choice;
    if (request.reasoning?.effort && request.reasoning.effort !== 'none') {
      out.reasoning_effort = request.reasoning.effort;
    }
    return out;
  }

  /**
   * OpenAI Chat Completions response → Unified.
   * The upstream's response shape already matches Unified — pass through.
   * The endpoint AnthropicTransformer re-encodes to Anthropic for the SDK.
   */
  async transformResponseOut(
    response: Response,
    _context: TransformerContext,
  ): Promise<Response> {
    return response;
  }
}
