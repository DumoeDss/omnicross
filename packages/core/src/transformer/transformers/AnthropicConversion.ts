/**
 * AnthropicConversion - Non-streaming message-format conversion entry point
 * for AnthropicTransformer.
 *
 * - `transformAnthropicRequestToUnified` - Anthropic request -> UnifiedChatRequest
 *
 * Re-exports related conversion helpers so the facade has a single conversion
 * import surface:
 * - `buildAnthropicRequestBody`            (`./AnthropicRequestBuilder`)
 * - `convertAnthropicResponseToOpenAI`     (`./AnthropicResponseConversion`)
 * - `convertOpenAIResponseToAnthropic`     (`./AnthropicResponseConversion`)
 *
 * Internal module of AnthropicTransformer; do not import the facade here.
 *
 * @module transformer/transformers/AnthropicConversion
 */

import type { UnifiedChatRequest, UnifiedMessage } from '../types';
import { normalizeThinkLevel } from '../reasoning-effort';

import { convertAnthropicToolsToOpenAI, isServerSideTool } from './AnthropicToolHandling';
import type {
  AnthropicContent,
  AnthropicImageContent,
  AnthropicRequest,
  AnthropicTextContent,
  AnthropicThinkingContent,
  AnthropicToolResultContent,
  AnthropicToolUseContent,
} from './AnthropicTypes';
import { flattenToolResultContent, formatBase64, getThinkLevel } from './AnthropicTypes';
import { recordDroppedField } from '../transformWarnings';

export { buildAnthropicRequestBody } from './AnthropicRequestBuilder';
export {
  convertAnthropicResponseToOpenAI,
  convertOpenAIResponseToAnthropic,
} from './AnthropicResponseConversion';

/**
 * Transform an Anthropic Messages API request body to the unified request shape.
 * (Reverse direction of `buildAnthropicRequestBody`.)
 */
export function transformAnthropicRequestToUnified(request: unknown): UnifiedChatRequest {
  const anthropicRequest = request as AnthropicRequest;
  const messages: UnifiedMessage[] = [];
  /** Set when any assistant turn carried a redacted_thinking block (audit). */
  let redactedSeen = false;

  // Handle system message
  if (anthropicRequest.system) {
    if (typeof anthropicRequest.system === 'string') {
      messages.push({
        role: 'system',
        content: anthropicRequest.system,
      });
    } else if (Array.isArray(anthropicRequest.system)) {
      const textParts = anthropicRequest.system
        .filter((item) => item.type === 'text' && item.text)
        .map((item) => ({
          type: 'text' as const,
          text: item.text,
          cache_control: item.cache_control as { type?: string } | undefined,
        }));
      if (textParts.length > 0) {
        messages.push({
          role: 'system',
          content: textParts,
        });
      }
    }
  }

  // Process messages
  const requestMessages = JSON.parse(JSON.stringify(anthropicRequest.messages || []));

  for (const msg of requestMessages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;

    // String content
    if (typeof msg.content === 'string') {
      messages.push({
        role: msg.role,
        content: msg.content,
      });
      continue;
    }

    // Array content
    if (Array.isArray(msg.content)) {
      if (msg.role === 'user') {
        // Handle tool results
        const toolParts = msg.content.filter(
          (c: AnthropicContent) => c.type === 'tool_result' && (c as AnthropicToolResultContent).tool_use_id
        );
        for (const tool of toolParts as AnthropicToolResultContent[]) {
          messages.push({
            role: 'tool',
            // Claude Code sends tool results as a block ARRAY; stringifying it
            // fed the model the literal `[{"type":"text","text":"…"}]` envelope
            // on every tool result.
            content: flattenToolResultContent(tool.content),
            tool_call_id: tool.tool_use_id,
            cache_control: tool.cache_control,
          });
        }

        // Handle text and images
        const textAndMediaParts = msg.content.filter(
          (c: AnthropicContent) =>
            (c.type === 'text' && (c as AnthropicTextContent).text) ||
            (c.type === 'image' && (c as AnthropicImageContent).source)
        );
        if (textAndMediaParts.length > 0) {
          messages.push({
            role: 'user',
            content: textAndMediaParts.map((part: AnthropicContent) => {
              if (part.type === 'image') {
                const imagePart = part as AnthropicImageContent;
                return {
                  type: 'image_url' as const,
                  image_url: {
                    url:
                      imagePart.source.type === 'base64'
                        ? formatBase64(imagePart.source.data || '', imagePart.source.media_type)
                        : imagePart.source.url || '',
                  },
                  media_type: imagePart.source.media_type,
                };
              }
              return {
                type: 'text' as const,
                text: (part as AnthropicTextContent).text,
              };
            }),
          });
        }
      } else if (msg.role === 'assistant') {
        const assistantMessage: UnifiedMessage = {
          role: 'assistant',
          content: '',
        };

        // Extract text
        const textParts = msg.content.filter(
          (c: AnthropicContent) => c.type === 'text' && (c as AnthropicTextContent).text
        ) as AnthropicTextContent[];
        if (textParts.length > 0) {
          assistantMessage.content = textParts.map((t) => t.text).join('\n');
        }

        // Extract tool calls
        const toolCallParts = msg.content.filter(
          (c: AnthropicContent) => c.type === 'tool_use' && (c as AnthropicToolUseContent).id
        ) as AnthropicToolUseContent[];
        if (toolCallParts.length > 0) {
          assistantMessage.tool_calls = toolCallParts.map((tool) => ({
            id: tool.id,
            type: 'function' as const,
            function: {
              name: tool.name,
              arguments: JSON.stringify(tool.input || {}),
            },
          }));
        }

        // Extract thinking — IN BLOCK ORDER (R7/D5). The old `find` kept only
        // the FIRST thinking block and silently dropped the rest, and
        // `redacted_thinking` blocks vanished entirely. Now every block is
        // concatenated in order: `thinking` blocks contribute their content
        // (the first block's `signature` is kept — Unified has one signature
        // slot; later signatures are appended into the content so echo-back
        // upstreams keep the full material), and each `redacted_thinking`
        // contributes a `[redacted thinking omitted]` placeholder AT ITS
        // POSITION plus a dropped_field audit entry.
        // The block is preserved even when `signature` is absent: some
        // Anthropic-compatible providers (e.g. Xiaomi MiMo's
        // `/anthropic/v1/messages`) still require the prior assistant's
        // thinking content echoed back on the next tool_result turn.
        let thinkingText = '';
        let firstSignature: string | undefined;
        let sawRedacted = false;
        for (const block of msg.content) {
          if (block.type === 'thinking') {
            const t = (block as AnthropicThinkingContent).thinking;
            if (typeof t === 'string' && t.length > 0) {
              if (thinkingText.length > 0) thinkingText += '\n';
              thinkingText += t;
            }
            const signature = (block as AnthropicThinkingContent).signature;
            if (signature) {
              if (firstSignature === undefined) {
                firstSignature = signature;
              } else if (typeof t === 'string' && t.length > 0) {
                // Later-block signatures have no separate slot; keep them in
                // the content so nothing is lost (Q3 dialect handling).
                thinkingText += `\n[signature: ${signature}]`;
              }
            }
          } else if (block.type === 'redacted_thinking') {
            sawRedacted = true;
            if (thinkingText.length > 0) thinkingText += '\n';
            thinkingText += '[redacted thinking omitted]';
          }
        }
        if (thinkingText.length > 0) {
          assistantMessage.thinking = {
            content: thinkingText,
            signature: firstSignature,
          };
        }
        if (sawRedacted) {
          redactedSeen = true;
        }

        messages.push(assistantMessage);
      }
    }
  }

  // Separate server-side tools (web_search, code_execution, etc.) from regular function tools.
  // Server-side tools are preserved as-is and re-injected in transformRequestIn.
  const rawTools = (anthropicRequest.tools || []) as Array<Record<string, unknown>>;
  const serverSideTools = rawTools.filter(t => isServerSideTool(t));
  const functionTools = rawTools.length > 0
    ? convertAnthropicToolsToOpenAI(rawTools)
    : undefined;

  // Build result
  const result: UnifiedChatRequest = {
    messages,
    model: anthropicRequest.model,
    max_tokens: anthropicRequest.max_tokens,
    temperature: anthropicRequest.temperature,
    stream: anthropicRequest.stream,
    tools: functionTools?.length ? functionTools : undefined,
  };

  // R7 sampling/stop/metadata hub fields — captured ONLY when the caller sent
  // them, so encoder output is byte-identical for requests that omit them.
  const raw = anthropicRequest as AnthropicRequest & {
    stop_sequences?: unknown;
    top_p?: unknown;
    top_k?: unknown;
    metadata?: { user_id?: unknown } | undefined;
  };
  if (Array.isArray(raw.stop_sequences)) {
    result.stop = raw.stop_sequences.filter((s): s is string => typeof s === 'string');
  }
  if (typeof raw.top_p === 'number') result.top_p = raw.top_p;
  if (typeof raw.top_k === 'number') result.top_k = raw.top_k;
  if (typeof raw.metadata?.user_id === 'string') result.metadata_user_id = raw.metadata.user_id;

  if (redactedSeen) {
    recordDroppedField(result, 'redacted_thinking', 'unified');
  }

  // Preserve server-side tools for round-trip through transformer pipeline
  if (serverSideTools.length > 0) {
    (result as unknown as Record<string, unknown>)._serverSideTools = serverSideTools;
  }

  // Handle thinking config
  if (anthropicRequest.thinking) {
    if (anthropicRequest.thinking.type === 'disabled') {
      result.reasoning = { effort: 'none', enabled: false };
    } else if (anthropicRequest.thinking.type === 'adaptive') {
      const effort = normalizeThinkLevel(anthropicRequest.output_config?.effort);
      if (effort) result.reasoning = { effort, enabled: effort !== 'none' };
    } else {
      result.reasoning = {
        effort: getThinkLevel(anthropicRequest.thinking.budget_tokens),
        enabled: true,
        ...(typeof anthropicRequest.thinking.budget_tokens === 'number'
          ? { max_tokens: anthropicRequest.thinking.budget_tokens }
          : {}),
      };
    }
  }

  // Handle tool choice
  if (anthropicRequest.tool_choice) {
    if (anthropicRequest.tool_choice.type === 'tool' && anthropicRequest.tool_choice.name) {
      result.tool_choice = {
        type: 'function',
        function: { name: anthropicRequest.tool_choice.name },
      };
    } else {
      result.tool_choice = anthropicRequest.tool_choice.type;
    }
  }

  return result;
}
