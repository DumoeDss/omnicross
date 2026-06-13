/**
 * Anthropic → OpenAI API conversion.
 *
 * Used by the claude-code-rerouter direction: clients call our endpoint with
 * an Anthropic-style payload, we forward to an upstream OpenAI provider.
 *
 * Includes:
 * - Response conversion (chat + tools + thinking blocks)
 * - Request conversion (reverse direction)
 * - Streaming chunk transform (Anthropic SSE → OpenAI SSE)
 * - Thinking-aware response enrichment
 */

import type {
  AnthropicChatRequest,
  AnthropicChatResponse,
  AnthropicContentPart,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIToolCall,
} from '@omnicross/contracts/completion-types';

import { mapAnthropicStopReason } from './shared';

/**
 * Convert Anthropic response to OpenAI format.
 */
export function convertAnthropicToOpenAI(
  response: AnthropicChatResponse
): OpenAIChatResponse {
  const content: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  let reasoningContent = '';

  // Process content blocks
  for (const block of response.content) {
    if (block.type === 'text') {
      content.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    } else if (block.type === 'thinking') {
      reasoningContent += block.thinking;
    }
  }

  const finishReason = mapAnthropicStopReason(response.stop_reason);

  const result: OpenAIChatResponse = {
    id: response.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content.join('\n') || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens + response.usage.output_tokens,
    },
  };

  if (reasoningContent) {
    result.reasoning_content = reasoningContent;
  }

  return result;
}

/**
 * Convert Anthropic request to OpenAI format (reverse direction).
 */
export function convertAnthropicRequestToOpenAI(
  request: AnthropicChatRequest
): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];

  // Add system message if present
  if (request.system) {
    if (typeof request.system === 'string') {
      messages.push({ role: 'system', content: request.system });
    } else if (Array.isArray(request.system)) {
      const systemText = request.system
        .filter(s => s.type === 'text')
        .map(s => s.text)
        .join('\n');
      messages.push({ role: 'system', content: systemText });
    }
  }

  // Convert messages
  for (const msg of request.messages) {
    if (typeof msg.content === 'string') {
      messages.push({
        role: msg.role,
        content: msg.content,
      });
    } else if (Array.isArray(msg.content)) {
      const openaiContent: OpenAIContentPart[] = [];
      const toolCalls: OpenAIToolCall[] = [];
      let toolResultId: string | undefined;
      let toolResultContent: string | undefined;

      for (const part of msg.content) {
        if (part.type === 'text') {
          openaiContent.push({ type: 'text', text: part.text });
        } else if (part.type === 'image') {
          if (part.source.type === 'base64') {
            openaiContent.push({
              type: 'image_url',
              image_url: {
                url: `data:${part.source.media_type};base64,${part.source.data}`,
              },
            });
          } else if (part.source.url) {
            openaiContent.push({
              type: 'image_url',
              image_url: { url: part.source.url },
            });
          }
        } else if (part.type === 'tool_use') {
          toolCalls.push({
            id: part.id,
            type: 'function',
            function: {
              name: part.name,
              arguments: JSON.stringify(part.input),
            },
          });
        } else if (part.type === 'tool_result') {
          toolResultId = part.tool_use_id;
          toolResultContent = typeof part.content === 'string'
            ? part.content
            : JSON.stringify(part.content);
        }
      }

      if (toolResultId && toolResultContent !== undefined) {
        messages.push({
          role: 'tool',
          tool_call_id: toolResultId,
          content: toolResultContent,
        });
      } else if (toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: openaiContent.length > 0
            ? openaiContent.map(c => c.type === 'text' ? c.text : '').join('\n')
            : null,
          tool_calls: toolCalls,
        });
      } else {
        messages.push({
          role: msg.role,
          content: openaiContent.length > 0 ? openaiContent : null,
        });
      }
    }
  }

  const result: OpenAIChatRequest = {
    model: request.model,
    messages,
    max_tokens: request.max_tokens,
    stream: request.stream,
  };

  // Convert tools
  if (request.tools && request.tools.length > 0) {
    result.tools = request.tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));

    if (request.tool_choice) {
      if (request.tool_choice.type === 'auto') {
        result.tool_choice = 'auto';
      } else if (request.tool_choice.type === 'any') {
        result.tool_choice = 'required';
      } else if (request.tool_choice.type === 'tool') {
        result.tool_choice = {
          type: 'function',
          function: { name: request.tool_choice.name },
        };
      }
    }
  }

  return result;
}

/**
 * Convert Anthropic response to OpenAI with thinking content preserved.
 */
export function convertAnthropicToOpenAIWithThinking(
  response: AnthropicChatResponse
): OpenAIChatResponse {
  const baseResult = convertAnthropicToOpenAI(response);

  // Extract thinking content
  const thinkingBlocks = response.content.filter(
    (block): block is AnthropicContentPart & { type: 'thinking' } =>
      block.type === 'thinking'
  );

  if (thinkingBlocks.length > 0) {
    baseResult.reasoning_content = thinkingBlocks
      .map(block => ('thinking' in block ? block.thinking : ''))
      .join('\n');
  }

  return baseResult;
}

/**
 * Convert Anthropic streaming response to OpenAI format.
 */
export async function* convertAnthropicStreamToOpenAI(
  anthropicStream: AsyncIterable<string>
): AsyncGenerator<string> {
  let messageId = '';
  let model = 'unknown';
  const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();

  for await (const line of anthropicStream) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();

    try {
      const event = JSON.parse(data);

      switch (event.type) {
        case 'message_start':
          messageId = event.message?.id || `chatcmpl-${Date.now()}`;
          model = event.message?.model || model;
          break;

        case 'content_block_delta':
          if (event.delta?.type === 'text_delta') {
            yield `data: ${JSON.stringify({
              id: messageId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{
                index: 0,
                delta: { content: event.delta.text },
                finish_reason: null
              }]
            })}\n\n`;
          } else if (event.delta?.type === 'thinking_delta') {
            yield `data: ${JSON.stringify({
              id: messageId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{
                index: 0,
                delta: { reasoning_content: event.delta.thinking },
                finish_reason: null
              }]
            })}\n\n`;
          } else if (event.delta?.type === 'input_json_delta') {
            const toolIndex = event.index || 0;
            const tc = toolCalls.get(toolIndex);
            if (tc) {
              yield `data: ${JSON.stringify({
                id: messageId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: toolIndex,
                      function: { arguments: event.delta.partial_json }
                    }]
                  },
                  finish_reason: null
                }]
              })}\n\n`;
            }
          }
          break;

        case 'content_block_start':
          if (event.content_block?.type === 'tool_use') {
            const toolIndex = event.index || 0;
            toolCalls.set(toolIndex, {
              id: event.content_block.id,
              name: event.content_block.name,
              arguments: ''
            });
            yield `data: ${JSON.stringify({
              id: messageId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: toolIndex,
                    id: event.content_block.id,
                    type: 'function',
                    function: { name: event.content_block.name, arguments: '' }
                  }]
                },
                finish_reason: null
              }]
            })}\n\n`;
          }
          break;

        case 'message_delta':
          if (event.delta?.stop_reason) {
            const finishReason = mapAnthropicStopReason(event.delta.stop_reason);
            yield `data: ${JSON.stringify({
              id: messageId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: finishReason
              }],
              usage: event.usage ? {
                prompt_tokens: event.usage.input_tokens || 0,
                completion_tokens: event.usage.output_tokens || 0,
                total_tokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0)
              } : undefined
            })}\n\n`;
          }
          break;

        case 'message_stop':
          yield 'data: [DONE]\n\n';
          break;
      }
    } catch {
      // Skip malformed events
    }
  }
}
