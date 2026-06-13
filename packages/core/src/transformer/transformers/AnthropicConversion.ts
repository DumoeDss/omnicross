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
import { formatBase64, getThinkLevel } from './AnthropicTypes';

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
            content: typeof tool.content === 'string' ? tool.content : JSON.stringify(tool.content),
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

        // Extract thinking — preserve the block even when `signature` is
        // absent. Some Anthropic-compatible providers (e.g. Xiaomi MiMo's
        // `/anthropic/v1/messages`) omit the signature but still require the
        // prior assistant's thinking content to be echoed back on the next
        // tool_result turn — dropping it here yields a 400 "reasoning_content
        // must be passed back" from upstream on multi-round tool calls.
        const thinkingPart = msg.content.find(
          (c: AnthropicContent) => c.type === 'thinking'
        ) as AnthropicThinkingContent | undefined;
        if (thinkingPart?.thinking) {
          assistantMessage.thinking = {
            content: thinkingPart.thinking,
            signature: thinkingPart.signature,
          };
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

  // Preserve server-side tools for round-trip through transformer pipeline
  if (serverSideTools.length > 0) {
    (result as unknown as Record<string, unknown>)._serverSideTools = serverSideTools;
  }

  // Handle thinking config
  if (anthropicRequest.thinking) {
    result.reasoning = {
      effort: getThinkLevel(anthropicRequest.thinking.budget_tokens),
      enabled: anthropicRequest.thinking.type === 'enabled',
    };
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
