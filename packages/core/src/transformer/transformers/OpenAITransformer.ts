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

import { applyOpenAIChatReasoning } from '../../reasoning/openai-chat-wire';
import type {
  LLMProvider,
  MessageContent,
  Transformer,
  TransformerContext,
  TransformerLogger,
  UnifiedChatRequest,
  UnifiedMessage,
} from '../types';
import { extractReasoningIntent, resolveReasoningPlan } from '../reasoning-effort';
import { recordDroppedField } from '../transformWarnings';
import {
  downgradeJsonSchemaBody,
  isJsonObjectOnlyProvider,
} from './utils/structuredOutput';
import {
  applyReasoningReplay,
  isReasoningReplayLearned,
  isReasoningReplayProvider,
  reasoningReplayKey,
} from './utils/reasoningReplay';
import type { ReasoningReplayEntry } from './utils/reasoningReplay';
import { readAnthropicSSE } from './AnthropicSSE';

/** Message-level keys that must never reach an OpenAI chat upstream. */
const FOREIGN_MESSAGE_KEYS = ['cache_control', 'thinking', 'is_error'] as const;

/**
 * Top-level keys that must never reach an OpenAI chat upstream.
 *
 * R7 additions (`claude-api-transform-fidelity`): `top_k` (no chat-wire
 * counterpart — audited via `_transformWarnings`), `metadata_user_id` (MAPPED
 * to the chat wire's `user` below before the blacklist takes effect — listed
 * so the hub spelling itself never leaks), and the internal `_transformWarnings`
 * audit channel (never serialized anywhere).
 *
 * `_serverSideTools` is the Anthropic decoder's transport stash for server-side
 * tools (`web_search_20250305`, …) riding the Unified request for the
 * Anthropic→Anthropic round-trip (`AnthropicRequestBuilder` re-merges them into
 * `tools`). On this wire they have no representation — an OpenAI-compatible
 * upstream that relays to Anthropic rejects the stray top-level field with
 * `Extra inputs are not permitted`, so it must be dropped, not passed through.
 */
const FOREIGN_BODY_KEYS = ['meta', 'reasoning', 'thinking', 'top_k', 'metadata_user_id', '_transformWarnings', '_serverSideTools'] as const;

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

/** Remove proxy replay envelopes without stripping native provider extensions. */
function chatExtraContent(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const extra = { ...value as Record<string, unknown> };
  delete extra.omnicross;
  delete extra.responses;
  if (extra.google && typeof extra.google === 'object' && !Array.isArray(extra.google)) {
    const google = { ...extra.google as Record<string, unknown> };
    delete google.parts;
    delete google.request;
    delete google.finishReason;
    if (Object.keys(google).length) extra.google = google;
    else delete extra.google;
  }
  return Object.keys(extra).length ? extra : undefined;
}

export class OpenAITransformer implements Transformer {
  static TransformerName = 'openai';
  name = 'openai';
  endPoint = '/v1/chat/completions';
  logger?: TransformerLogger;

  /** Decode native Chat history without discarding provider-specific fields. */
  async transformRequestOut(request: unknown, _context: TransformerContext): Promise<UnifiedChatRequest> {
    _context.chatSourceFormat = this.name;
    const body = request as UnifiedChatRequest;
    return {
      ...body,
      messages: body.messages.map((message) => {
        const native = message as unknown as Record<string, unknown>;
        const extra = native.extra_content as { omnicross?: { thinking?: UnifiedMessage['thinking'] } } | undefined;
        const reasoning = native.reasoning_content;
        if (message.role !== 'assistant') return message;
        if (extra?.omnicross?.thinking) return { ...message, thinking: extra.omnicross.thinking };
        return typeof reasoning === 'string' ? { ...message, thinking: { content: reasoning } } : message;
      }),
    };
  }

  /** Unified reasoning has a native Chat spelling at the client boundary. */
  async transformResponseIn(response: Response, _context?: TransformerContext): Promise<Response> {
    if (!response.ok) return response;
    const encode = (data: Record<string, unknown>) => {
      for (const choice of (Array.isArray(data.choices) ? data.choices : []) as Array<Record<string, unknown>>) {
        const message = (choice.message ?? choice.delta) as Record<string, unknown> | undefined;
        if (!message?.thinking || typeof message.thinking !== 'object') continue;
        const thinking = message.thinking as Record<string, unknown>;
        if (message.reasoning_content === undefined && typeof thinking.content === 'string') {
          message.reasoning_content = thinking.content;
        }
        const extra = message.extra_content as Record<string, unknown> | undefined;
        message.extra_content = {
          ...extra,
          omnicross: { ...(extra?.omnicross as Record<string, unknown> | undefined), thinking },
        };
        delete message.thinking;
      }
      return data;
    };
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      return new Response(JSON.stringify(encode(await response.json())), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    const encoder = new TextEncoder();
    let cancelled = false;
    return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        let terminal = false;
        let failed = false;
        try {
          await readAnthropicSSE(reader, (event) => {
            if (cancelled) return false;
            const chunk = encode(event);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            if (chunk.error) {
              failed = true;
              return false;
            }
            if (Array.isArray(chunk.choices)) {
              terminal ||= chunk.choices.some((choice: unknown) =>
                choice !== null && typeof choice === 'object' && 'finish_reason' in choice
                && typeof choice.finish_reason === 'string');
            }
          });
          if (cancelled) return;
          if (!failed && !terminal) throw new Error('Chat stream ended before a finish reason');
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (error) {
          if (!cancelled) controller.error(error);
        } finally {
          try { await reader.cancel(); } finally { reader.releaseLock(); }
        }
      },
      cancel(reason) {
        cancelled = true;
        return reader.cancel(reason);
      },
    }), { status: response.status, headers: { 'Content-Type': 'text/event-stream' } });
  }

  /**
   * Unified → OpenAI Chat Completions.
   */
  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: LLMProvider,
    context: TransformerContext,
  ): Promise<Record<string, unknown>> {
    const source = request as unknown as Record<string, unknown>;
    if (Array.isArray(source._serverSideTools) && source._serverSideTools.length) {
      throw new Error('OpenAI Chat cannot represent Anthropic server-side tools');
    }
    const out: Record<string, unknown> = {};

    if (context.chatSourceFormat === this.name && !request.reasoning && source.thinking !== undefined) {
      out.thinking = source.thinking;
    }
    // Pass through every field the chat wire may legitimately carry.
    for (const key of Object.keys(source)) {
      if ((FOREIGN_BODY_KEYS as readonly string[]).includes(key)) continue;
      out[key] = source[key];
    }

    // R7 field mapping + drop auditing (stop / top_p ride the blacklist
    // passthrough above untouched — the chat wire has both fields natively).
    if (request.metadata_user_id !== undefined) {
      out.user = request.metadata_user_id;
    }
    if (request.top_k !== undefined) {
      recordDroppedField(request, 'top_k', 'openai-chat');
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
        if (message.role === 'tool') {
          if (Array.isArray(message.content) && message.content.some((part) => part.type !== 'text')) {
            throw new Error('OpenAI Chat tool results cannot contain images or other non-text content');
          }
          const text = Array.isArray(message.content)
            ? message.content.map((part) => part.type === 'text' ? part.text : '').join('\n')
            : message.content;
          encoded.content = message.is_error ? `Tool execution failed.\n${text ?? ''}` : text;
        }
        if (encoded.extra_content !== undefined) {
          const extra = chatExtraContent(encoded.extra_content);
          if (extra) encoded.extra_content = extra;
          else delete encoded.extra_content;
        }
        if (message.tool_calls?.some((call) => 'extra_content' in call)) {
          encoded.tool_calls = message.tool_calls.map((call) => {
            if (!('extra_content' in call)) return call;
            const encodedCall = { ...call } as Record<string, unknown>;
            const extra = chatExtraContent(call.extra_content);
            if (extra) encodedCall.extra_content = extra;
            else delete encodedCall.extra_content;
            return encodedCall;
          });
        }
        // Anthropic thinking block → the chat wire's reasoning field. `signature`
        // is Anthropic-only and has nowhere to go.
        const thinkingContent = message.thinking?.content;
        if (context.responsesSourceFormat !== 'openai-response' && encoded.reasoning_content === undefined && typeof thinkingContent === 'string' && thinkingContent.length > 0) {
          encoded.reasoning_content = thinkingContent;
        }
        return encoded;
      });
    }

    // Encode negotiated reasoning using the target's actual Chat wire control.
    // Native fields without a unified policy remain preserved on same-format paths.
    const reasoningPlan = request.reasoning
      ? resolveReasoningPlan({
          intent: extractReasoningIntent(request),
          model: request.model,
          provider,
          target: 'openai-chat',
          requestMaxTokens: request.max_tokens,
        }) ?? { kind: 'off' as const }
      : undefined;
    applyOpenAIChatReasoning(out, reasoningPlan, provider, request.model, source.thinking);

    // Reasoning replay: DeepSeek v4 thinking mode rejects a request whose
    // thinking-turn assistant history lacks `reasoning_content` (400 "The
    // `reasoning_content` in the thinking mode must be passed back"). The
    // Responses ingress stashes the client's replayed `reasoning` items on the
    // shared context keyed by assistant-message index. Replay them only for
    // upstreams that demand it — for everyone else the field is at best noise
    // and at worst a rejection (classic deepseek-r1 FORBIDS it in
    // input). Omitted effort does not disable default-on upstream thinking.
    // Both static and learned demands remain active unless the outgoing wire
    // actually switches reasoning off.
    const reasoningReplay = context.responsesReasoningReplay as
      | ReasoningReplayEntry[]
      | undefined;
    const thinking = out.thinking as { type?: unknown } | undefined;
    const reasoningDisabled = thinking?.type === 'disabled'
      || out.reasoning_effort === 'none' || out.enable_thinking === false;
    if (reasoningReplay?.length && !reasoningDisabled) {
      const replayLearned = isReasoningReplayLearned(reasoningReplayKey(provider, request.model));
      if (replayLearned || isReasoningReplayProvider(provider, request.model)) {
        applyReasoningReplay(out, reasoningReplay);
      }
    }

    // Structured-output fallback: DeepSeek's chat wire answers 400 "This
    // response_format type is unavailable now" for `json_schema` and supports
    // only `json_object`. Forwarding it untouched killed codex's structured
    // turns (`exec --output-schema`, TUI recap, guardian review) outright.
    // The schema is folded into a system instruction so the model still knows
    // the shape; the runtime fallback in the Responses driver covers unknown
    // upstreams the same way after one rejected round trip.
    if (isJsonObjectOnlyProvider(provider)) {
      downgradeJsonSchemaBody(out);
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
