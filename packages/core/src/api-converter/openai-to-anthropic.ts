/**
 * OpenAI → Anthropic API conversion.
 *
 * Used by the claude-code-router direction: clients call our endpoint with
 * an OpenAI-style payload, we forward to an upstream Anthropic provider.
 *
 * Includes:
 * - Request conversion (chat + tools)
 * - Streaming chunk transform (OpenAI SSE → Anthropic SSE)
 * - Thinking-aware request enrichment
 */

import type {
  AnthropicChatRequest,
  AnthropicChatResponse,
  AnthropicContentPart,
  AnthropicMessage,
  AnthropicSystemContent,
  ConversionConfig,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIContentPart,
  OpenAIMessage,
} from '@omnicross/contracts/completion-types';

import { convertOpenAITool, mapOpenAIFinishReason } from './shared';

/**
 * Convert OpenAI chat request to Anthropic format.
 */
export function convertOpenAIToAnthropic(
  request: OpenAIChatRequest,
  config: ConversionConfig
): AnthropicChatRequest {
  const messages: AnthropicMessage[] = [];
  let system: string | AnthropicSystemContent[] | undefined;

  // Process messages
  for (const msg of request.messages) {
    // Handle system message
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') {
        system = msg.content;
      } else if (Array.isArray(msg.content)) {
        system = msg.content
          .filter((p): p is OpenAIContentPart & { type: 'text' } => p.type === 'text')
          .map(p => ({ type: 'text' as const, text: p.text || '' }));
      }
      continue;
    }

    // Handle tool message
    if (msg.role === 'tool' && msg.tool_call_id) {
      const toolResult: AnthropicContentPart = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      };

      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
        (lastMsg.content as AnthropicContentPart[]).push(toolResult);
      } else {
        messages.push({ role: 'user', content: [toolResult] });
      }
      continue;
    }

    // Handle assistant message with tool calls
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const content: AnthropicContentPart[] = [];

      if (msg.content) {
        if (typeof msg.content === 'string') {
          content.push({ type: 'text', text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text' && part.text) {
              content.push({ type: 'text', text: part.text });
            }
          }
        }
      }

      for (const tc of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}'),
        });
      }

      messages.push({ role: 'assistant', content });
      continue;
    }

    // Handle regular user/assistant messages
    if (msg.role === 'user' || msg.role === 'assistant') {
      const content = convertOpenAIMessageContent(msg);
      messages.push({ role: msg.role, content });
    }
  }

  // Map model name
  let model = request.model;
  if (config.modelMapping && config.modelMapping[model]) {
    model = config.modelMapping[model];
  } else if (!model.startsWith('claude')) {
    model = config.defaultModel;
  }

  const result: AnthropicChatRequest = {
    model,
    // Anthropic requires max_tokens; use high default (16384) if not explicitly set
    // This prevents output truncation for long responses
    max_tokens: request.max_tokens || 16384,
    messages,
    stream: request.stream,
  };

  if (system) {
    result.system = system;
  }

  // Convert tools
  if (request.tools && request.tools.length > 0) {
    result.tools = request.tools.map(convertOpenAITool);

    if (request.tool_choice) {
      if (request.tool_choice === 'auto') {
        result.tool_choice = { type: 'auto' };
      } else if (request.tool_choice === 'required') {
        result.tool_choice = { type: 'any' };
      } else if (typeof request.tool_choice === 'object') {
        result.tool_choice = {
          type: 'tool',
          name: request.tool_choice.function.name,
        };
      }
    }
  }

  return result;
}

function convertOpenAIMessageContent(msg: OpenAIMessage): string | AnthropicContentPart[] {
  if (typeof msg.content === 'string') {
    return msg.content;
  }

  if (!msg.content || !Array.isArray(msg.content)) {
    return '';
  }

  const parts: AnthropicContentPart[] = [];

  for (const part of msg.content) {
    if (part.type === 'text' && part.text) {
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && part.image_url) {
      const url = part.image_url.url;

      if (url.startsWith('data:')) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          parts.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: match[1],
              data: match[2],
            },
          });
        }
      } else {
        parts.push({
          type: 'image',
          source: { type: 'url', url },
        });
      }
    }
  }

  return parts.length > 0 ? parts : '';
}

/**
 * Convert OpenAI response to Anthropic format.
 */
export function convertOpenAIResponseToAnthropic(
  response: OpenAIChatResponse
): AnthropicChatResponse {
  const content: AnthropicContentPart[] = [];
  const choice = response.choices[0];

  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content });
  }

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      });
    }
  }

  // Add reasoning content as thinking block
  if (response.reasoning_content) {
    content.unshift({
      type: 'thinking',
      thinking: response.reasoning_content,
    });
  }

  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content,
    stop_reason: mapOpenAIFinishReason(choice.finish_reason),
    usage: {
      input_tokens: response.usage.prompt_tokens,
      output_tokens: response.usage.completion_tokens,
    },
  };
}

/**
 * Convert OpenAI request to Anthropic with thinking support.
 */
export function convertOpenAIToAnthropicWithThinking(
  request: OpenAIChatRequest,
  config: ConversionConfig & { thinkingBudget?: number }
): AnthropicChatRequest {
  const baseResult = convertOpenAIToAnthropic(request, config);

  // Add thinking configuration if enabled
  if (config.enableThinking) {
    baseResult.thinking = {
      type: 'enabled',
      budget_tokens: config.thinkingBudget || 10000
    };
  }

  return baseResult;
}

/**
 * Convert OpenAI streaming response to Anthropic format.
 * This creates an async generator that yields Anthropic SSE events.
 */
export async function* convertOpenAIStreamToAnthropic(
  openaiStream: AsyncIterable<string>
): AsyncGenerator<string> {
  const messageId = `msg_${Date.now()}`;
  let hasStarted = false;
  let hasTextContentStarted = false;
  let hasThinkingContentStarted = false;
  let contentIndex = 0;
  let model = 'unknown';
  const toolCalls = new Map<number, { id: string; name: string; contentIndex: number }>();

  for await (const line of openaiStream) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();

    if (data === '[DONE]') {
      // Close any open content blocks
      if (hasTextContentStarted) {
        yield `event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index: contentIndex
        })}\n\n`;
        contentIndex++;
        hasTextContentStarted = false;
      }

      if (hasThinkingContentStarted) {
        yield `event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index: contentIndex
        })}\n\n`;
        contentIndex++;
        hasThinkingContentStarted = false;
      }

      // Close tool call blocks
      for (const [, tc] of toolCalls) {
        yield `event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index: tc.contentIndex
        })}\n\n`;
      }

      // Emit message_delta and message_stop
      yield `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 0 }
      })}\n\n`;
      yield `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
      break;
    }

    try {
      const chunk = JSON.parse(data);
      model = chunk.model || model;

      // Emit message_start on first chunk
      if (!hasStarted) {
        hasStarted = true;
        yield `event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        })}\n\n`;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      // Handle text content
      if (choice.delta?.content) {
        if (!hasTextContentStarted) {
          hasTextContentStarted = true;
          yield `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: contentIndex,
            content_block: { type: 'text', text: '' }
          })}\n\n`;
        }

        yield `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: contentIndex,
          delta: { type: 'text_delta', text: choice.delta.content }
        })}\n\n`;
      }

      // Handle reasoning/thinking content
      if (choice.delta?.reasoning_content) {
        // Close text content block if open
        if (hasTextContentStarted) {
          yield `event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: contentIndex
          })}\n\n`;
          contentIndex++;
          hasTextContentStarted = false;
        }

        if (!hasThinkingContentStarted) {
          hasThinkingContentStarted = true;
          yield `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: contentIndex,
            content_block: { type: 'thinking', thinking: '' }
          })}\n\n`;
        }

        yield `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: contentIndex,
          delta: { type: 'thinking_delta', thinking: choice.delta.reasoning_content }
        })}\n\n`;
      }

      // Handle tool calls
      if (choice.delta?.tool_calls) {
        // Close text content block if open
        if (hasTextContentStarted) {
          yield `event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: contentIndex
          })}\n\n`;
          contentIndex++;
          hasTextContentStarted = false;
        }

        for (const toolCall of choice.delta.tool_calls) {
          const toolIndex = toolCall.index ?? 0;

          if (!toolCalls.has(toolIndex)) {
            const toolContentIndex = contentIndex++;
            const toolId = toolCall.id || `call_${Date.now()}_${toolIndex}`;
            const toolName = toolCall.function?.name || `tool_${toolIndex}`;

            toolCalls.set(toolIndex, { id: toolId, name: toolName, contentIndex: toolContentIndex });

            yield `event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: toolContentIndex,
              content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} }
            })}\n\n`;
          }

          if (toolCall.function?.arguments) {
            const tc = toolCalls.get(toolIndex)!;
            yield `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: tc.contentIndex,
              delta: { type: 'input_json_delta', partial_json: toolCall.function.arguments }
            })}\n\n`;
          }
        }
      }

      // Handle finish reason
      if (choice.finish_reason) {
        // Close any open content blocks
        if (hasTextContentStarted) {
          yield `event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: contentIndex
          })}\n\n`;
          contentIndex++;
          hasTextContentStarted = false;
        }

        // Close thinking block if open
        if (hasThinkingContentStarted) {
          yield `event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: contentIndex
          })}\n\n`;
          contentIndex++;
          hasThinkingContentStarted = false;
        }

        // Close tool call blocks
        for (const [, tc] of toolCalls) {
          yield `event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: tc.contentIndex
          })}\n\n`;
        }

        const stopReason = mapOpenAIFinishReason(choice.finish_reason);
        yield `event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: {
            input_tokens: chunk.usage?.prompt_tokens || 0,
            output_tokens: chunk.usage?.completion_tokens || 0
          }
        })}\n\n`;

        yield `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
      }
    } catch {
      // Skip malformed chunks
    }
  }
}
