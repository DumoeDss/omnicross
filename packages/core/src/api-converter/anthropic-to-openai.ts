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
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIToolCall,
} from '@omnicross/contracts/completion-types';

import { flattenToolResultContent, mapAnthropicStopReason, readSSEData } from './shared';

/**
 * Build an OpenAI Chat `usage` from an Anthropic usage block, preserving
 * prompt-cache counts. Anthropic `input_tokens` excludes cache; OpenAI
 * `prompt_tokens` treats cached tokens as a subset (readers compute
 * billable = prompt_tokens - cached_tokens). So fold both cache pools into
 * prompt_tokens and surface cache-read via prompt_tokens_details.cached_tokens.
 *
 * Mirrors `transformer/transformers/utils/usage-mapping.ts` (kept local to
 * avoid an api-converter → transformer layering edge).
 */
function anthropicUsageToChatUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): OpenAIChatResponse['usage'] {
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  const promptTokens = input + cacheRead + cacheCreation;
  const out: OpenAIChatResponse['usage'] = {
    prompt_tokens: promptTokens,
    completion_tokens: output,
    total_tokens: promptTokens + output,
  };
  if (cacheRead > 0) out.prompt_tokens_details = { cached_tokens: cacheRead };
  if (cacheCreation > 0) out.cache_creation_input_tokens = cacheCreation;
  return out;
}

/**
 * Convert Anthropic response to OpenAI format.
 */
export function convertAnthropicToOpenAI(
  response: AnthropicChatResponse
): OpenAIChatResponse {
  const content: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  let reasoningContent = '';
  const thinkingBlocks = response.content.filter(block => block.type === 'thinking' || block.type === 'redacted_thinking');

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
    } else if (block.type !== 'redacted_thinking') {
      throw new Error(`Cannot encode Anthropic response content in Chat: ${block.type}`);
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
          content: content.join('') || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          ...(thinkingBlocks.length ? { thinking: { content: reasoningContent, blocks: thinkingBlocks } } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: anthropicUsageToChatUsage(response.usage),
  };


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
      const toolResults: OpenAIMessage[] = [];
      let reasoning = '';
      const thinkingBlocks = msg.content.filter(part => part.type === 'thinking' || part.type === 'redacted_thinking');

      for (const part of msg.content) {
        if (part.type === 'text') {
          openaiContent.push({ type: 'text', text: part.text });
        } else if (part.type === 'document') {
          if (part.source.type !== 'base64') throw new Error('Chat document conversion requires inline base64 data');
          openaiContent.push({ type: 'file', file: {
            filename: part.title || 'document.pdf',
            file_data: `data:${part.source.media_type};base64,${part.source.data}`,
          } });
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
          toolResults.push({
            role: 'tool', tool_call_id: part.tool_use_id,
            content: part.is_error
              ? JSON.stringify({ error: flattenToolResultContent(part.content) })
              : flattenToolResultContent(part.content),
          });
        } else if (part.type === 'thinking') {
          reasoning += part.thinking;
        } else if (part.type !== 'redacted_thinking') {
          throw new Error(`Unsupported OpenAI content conversion: ${part.type}`);
        }
      }

      messages.push(...toolResults);
      if (toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: openaiContent.length > 0
            ? openaiContent.every(part => part.type === 'text')
              ? openaiContent.map(part => part.text).join('') : openaiContent
            : null,
          tool_calls: toolCalls,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(thinkingBlocks.length ? { thinking: { content: reasoning, blocks: thinkingBlocks } } : {}),
        });
      } else if (openaiContent.length || reasoning || !toolResults.length) {
        messages.push({
          role: msg.role,
          content: openaiContent.length > 0 ? openaiContent : null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(thinkingBlocks.length ? { thinking: { content: reasoning, blocks: thinkingBlocks } } : {}),
        });
      }
    }
  }

  const result: OpenAIChatRequest = {
    model: request.model,
    messages,
    max_tokens: request.max_tokens,
    stream: request.stream,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
    ...(request.stop_sequences !== undefined ? { stop: request.stop_sequences } : {}),
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
      } else if (request.tool_choice.type === 'none') {
        result.tool_choice = 'none';
      } else if (request.tool_choice.type === 'any') {
        result.tool_choice = 'required';
      } else if (request.tool_choice.type === 'tool') {
        result.tool_choice = {
          type: 'function',
          function: { name: request.tool_choice.name },
        };
      }
    }
    if (request.tool_choice?.disable_parallel_tool_use !== undefined) {
      result.parallel_tool_calls = !request.tool_choice.disable_parallel_tool_use;
    }
  }

  if (request.thinking) {
    throw new Error('Anthropic thinking configuration requires a target-specific OpenAI reasoning mapping');
  }
  return result;
}

/**
 * Convert Anthropic response to OpenAI with thinking content preserved.
 */
export function convertAnthropicToOpenAIWithThinking(
  response: AnthropicChatResponse
): OpenAIChatResponse {
  return convertAnthropicToOpenAI(response);
}

/**
 * Convert Anthropic streaming response to OpenAI format.
 */
export async function* convertAnthropicStreamToOpenAI(
  anthropicStream: AsyncIterable<string>
): AsyncGenerator<string> {
  let messageId = '';
  let model = 'unknown';
  let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const tools = new Map<number, number>();
  const thinkingIndices = new Set<number>();
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null, finalUsage = false) =>
    `data: ${JSON.stringify({
      id: messageId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(finalUsage ? { usage: anthropicUsageToChatUsage(usage) } : {}),
    })}\n\n`;
  for await (const data of readSSEData(anthropicStream)) {
    const event = JSON.parse(data);
    switch (event.type) {
      case 'message_start':
        messageId = event.message.id;
        model = event.message.model;
        usage = { ...usage, ...event.message.usage };
        yield chunk({ role: 'assistant', content: '' });
        break;
      case 'content_block_start': {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          const index = tools.size;
          tools.set(event.index, index);
          yield chunk({ tool_calls: [{
            index, id: block.id, type: 'function',
            function: { name: block.name, arguments: Object.keys(block.input ?? {}).length ? JSON.stringify(block.input) : '' },
          }] });
        } else if (block.type === 'text' && block.text) {
          yield chunk({ content: block.text });
        } else if (block.type === 'thinking') {
          thinkingIndices.add(event.index);
          yield chunk({
            ...(block.thinking ? { reasoning_content: block.thinking } : {}),
            thinking: { index: event.index, content: block.thinking || '', ...(block.signature ? { signature: block.signature } : {}) },
          });
        } else if (block.type === 'redacted_thinking') {
          yield chunk({ thinking: { index: event.index, type: block.type, data: block.data } });
        }
        break;
      }
      case 'content_block_delta':
        if (event.delta.type === 'text_delta') yield chunk({ content: event.delta.text });
        else if (event.delta.type === 'thinking_delta') yield chunk({
          reasoning_content: event.delta.thinking,
          thinking: { index: event.index, content: event.delta.thinking },
        });
        else if (event.delta.type === 'signature_delta') yield chunk({
          thinking: { index: event.index, signature: event.delta.signature },
        });
        else if (event.delta.type === 'input_json_delta') {
          const index = tools.get(event.index);
          if (index === undefined) throw new Error('Tool argument delta without a tool start');
          yield chunk({ tool_calls: [{ index, function: { arguments: event.delta.partial_json } }] });
        }
        break;
      case 'content_block_stop':
        if (thinkingIndices.has(event.index)) yield chunk({ thinking: { index: event.index, done: true } });
        break;
      case 'message_delta':
        usage = { ...usage, ...event.usage };
        if (event.delta?.stop_reason) yield chunk({}, mapAnthropicStopReason(event.delta.stop_reason), true);
        break;
      case 'message_stop':
        yield 'data: [DONE]\n\n';
        return;
      case 'error':
        yield `data: ${JSON.stringify({ error: event.error })}\n\n`;
        return;
    }
  }
  throw new Error('Anthropic stream ended before message_stop');
}
