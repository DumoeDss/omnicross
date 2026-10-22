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
  OpenAIMessage,
} from '@omnicross/contracts/completion-types';

import { convertOpenAITool, mapOpenAIFinishReason, readSSEData } from './shared';

/**
 * Convert OpenAI chat request to Anthropic format.
 */
export function convertOpenAIToAnthropic(
  request: OpenAIChatRequest,
  config: ConversionConfig
): AnthropicChatRequest {
  if (request.n !== undefined && request.n !== 1) {
    throw new Error('Anthropic Messages supports only one candidate (n=1)');
  }
  const messages: AnthropicMessage[] = [];
  const system: AnthropicSystemContent[] = [];

  // Process messages
  for (const msg of request.messages) {
    // Handle system message
    if (msg.role === 'system' || msg.role === 'developer') {
      if (typeof msg.content === 'string') {
        system.push({ type: 'text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type !== 'text') throw new Error(`Unsupported Anthropic system content: ${part.type}`);
          system.push({ type: 'text', text: part.text || '' });
        }
      }
      continue;
    }
    if (msg.role === 'tool' && !msg.tool_call_id) throw new Error('OpenAI tool result requires tool_call_id');

    // Handle tool message
    if (msg.role === 'tool' && msg.tool_call_id) {
      const toolResult: AnthropicContentPart = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: convertOpenAIMessageContent(msg),
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

      const messageContent = convertOpenAIMessageContent(msg);
      if (typeof messageContent === 'string') {
        if (messageContent) content.push({ type: 'text', text: messageContent });
      } else {
        content.push(...messageContent);
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
    max_tokens: request.max_completion_tokens ?? request.max_tokens ?? 16384,
    messages,
    stream: request.stream,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
    ...(request.stop !== undefined ? { stop_sequences: typeof request.stop === 'string' ? [request.stop] : request.stop } : {}),
  };

  if (system.length) {
    result.system = system;
  }

  // Convert tools
  if (request.tools && request.tools.length > 0) {
    result.tools = request.tools.map(convertOpenAITool);

    if (request.tool_choice) {
      if (request.tool_choice === 'auto') {
        result.tool_choice = { type: 'auto' };
      } else if (request.tool_choice === 'none') {
        result.tool_choice = { type: 'none' };
      } else if (request.tool_choice === 'required') {
        result.tool_choice = { type: 'any' };
      } else if (typeof request.tool_choice === 'object') {
        result.tool_choice = {
          type: 'tool',
          name: request.tool_choice.function.name,
        };
      }
    }
    if (request.parallel_tool_calls !== undefined) {
      result.tool_choice = {
        ...(result.tool_choice ?? { type: 'auto' }),
        disable_parallel_tool_use: !request.parallel_tool_calls,
      };
    }
  }

  if (request.reasoning) {
    if (request.reasoning.effort !== undefined) {
      throw new Error('OpenAI reasoning effort cannot be translated to an Anthropic thinking budget');
    }
    if (request.reasoning.enabled === false) result.thinking = { type: 'disabled' };
    else if (request.reasoning.max_tokens !== undefined) {
      result.thinking = { type: 'enabled', budget_tokens: request.reasoning.max_tokens };
    } else {
      throw new Error('Anthropic thinking requires an explicit token budget');
    }
  }
  return result;
}

function convertOpenAIMessageContent(msg: OpenAIMessage): string | AnthropicContentPart[] {
  const parts: AnthropicContentPart[] = [];
  if (msg.role === 'assistant') {
    if (msg.thinking?.blocks?.length) parts.push(...msg.thinking.blocks);
    else if (msg.reasoning_content ?? msg.thinking?.content) {
      parts.push({ type: 'thinking', thinking: msg.reasoning_content ?? msg.thinking!.content, signature: msg.thinking?.signature });
    }
  }
  if (typeof msg.content === 'string') {
    if (!parts.length) return msg.content;
    if (msg.content) parts.push({ type: 'text', text: msg.content });
    return parts;
  }
  if (!Array.isArray(msg.content)) return parts.length ? parts : '';
  for (const part of msg.content) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text ?? '' });
    } else if (part.type === 'file') {
      const match = part.file?.file_data?.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) throw new Error('Anthropic document conversion requires inline file_data');
      parts.push({
        type: 'document', ...(part.file?.filename ? { title: part.file.filename } : {}),
        source: { type: 'base64', media_type: match[1], data: match[2] },
      });
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
        } else {
          throw new Error('Invalid image data URL');
        }
      } else {
        parts.push({
          type: 'image',
          source: { type: 'url', url },
        });
      }
    } else {
      throw new Error(`Unsupported Anthropic content conversion: ${part.type}`);
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
  if (response.choices.length > 1) {
    throw new Error('Multiple Chat candidates cannot be represented by one Anthropic message');
  }
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

  // Chat Completions puts reasoning on the assistant message, not the response.
  const reasoning = choice.message.reasoning_content ?? response.reasoning_content;
  if (choice.message.thinking?.blocks?.length) {
    content.unshift(...choice.message.thinking.blocks);
  } else if (reasoning) {
    content.unshift({
      type: 'thinking',
      thinking: reasoning,
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
      input_tokens: response.usage.prompt_tokens - (response.usage.prompt_tokens_details?.cached_tokens ?? 0) - (response.usage.cache_creation_input_tokens ?? 0),
      ...(response.usage.prompt_tokens_details?.cached_tokens !== undefined
        ? { cache_read_input_tokens: response.usage.prompt_tokens_details.cached_tokens } : {}),
      ...(response.usage.cache_creation_input_tokens !== undefined
        ? { cache_creation_input_tokens: response.usage.cache_creation_input_tokens } : {}),
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
      budget_tokens: config.thinkingBudget ?? 10000
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
  let started = false;
  let nextIndex = 0;
  let active: { index: number; type: 'text' | 'thinking' } | undefined;
  const tools = new Map<number, { index: number; id: string; name: string; arguments: string }>();
  let finishReason: string | undefined;
  let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const event = (type: string, fields: Record<string, unknown> = {}) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;

  for await (const data of readSSEData(openaiStream)) {
    if (data === '[DONE]') break;
    const chunk = JSON.parse(data);
    if (chunk.error) {
      yield event('error', { error: { type: 'api_error', message: chunk.error.message || JSON.stringify(chunk.error) } });
      return;
    }
    if (chunk.usage) {
      const cacheRead = chunk.usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens;
      const cacheCreation = chunk.usage.cache_creation_input_tokens ?? usage.cache_creation_input_tokens;
      usage = {
        input_tokens: chunk.usage.prompt_tokens !== undefined
          ? chunk.usage.prompt_tokens - cacheRead - cacheCreation : usage.input_tokens,
        output_tokens: chunk.usage.completion_tokens ?? usage.output_tokens,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
      };
    }
    if (!started) {
      started = true;
      yield event('message_start', { message: {
        id: chunk.id || `msg_${Date.now()}`, type: 'message', role: 'assistant',
        model: chunk.model || 'unknown', content: [], stop_reason: null, stop_sequence: null, usage,
      } });
    }
    if ((chunk.choices?.length ?? 0) > 1 || chunk.choices?.some((choice: { index?: number }) => choice.index !== undefined && choice.index !== 0)) {
      throw new Error('Multiple Chat candidates cannot be represented by one Anthropic message');
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (delta.thinking?.type === 'redacted_thinking') {
      if (active) {
        yield event('content_block_stop', { index: active.index });
        active = undefined;
      }
      const index = nextIndex++;
      yield event('content_block_start', { index, content_block: { type: 'redacted_thinking', data: delta.thinking.data } });
      yield event('content_block_stop', { index });
    } else if (delta.thinking?.index !== undefined && !delta.thinking.done && (!active || active.type !== 'thinking')) {
      if (active) yield event('content_block_stop', { index: active.index });
      active = { index: nextIndex++, type: 'thinking' };
      yield event('content_block_start', { index: active.index, content_block: { type: 'thinking', thinking: '' } });
    }
    for (const [type, text] of [['thinking', delta.reasoning_content ?? delta.thinking?.content], ['text', delta.content]] as const) {
      if (!text) continue;
      if (active && active.type !== type) {
        yield event('content_block_stop', { index: active.index });
        active = undefined;
      }
      if (!active) {
        active = { index: nextIndex++, type };
        yield event('content_block_start', {
          index: active.index, content_block: type === 'text' ? { type, text: '' } : { type, thinking: '' },
        });
      }
      yield event('content_block_delta', {
        index: active.index,
        delta: type === 'text' ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text },
      });
    }
    if (delta.thinking?.signature && active?.type === 'thinking') {
      yield event('content_block_delta', { index: active.index, delta: { type: 'signature_delta', signature: delta.thinking.signature } });
    }
    if (delta.thinking?.done && active?.type === 'thinking') {
      yield event('content_block_stop', { index: active.index });
      active = undefined;
    }
    for (const tool of delta.tool_calls ?? []) {
      const key = tool.index ?? 0;
      let pending = tools.get(key);
      if (!pending) {
        pending = { index: -1, id: '', name: '', arguments: '' };
        tools.set(key, pending);
      }
      if (tool.id) pending.id += tool.id;
      if (tool.function?.name) pending.name += tool.function.name;
      if (tool.function?.arguments) pending.arguments += tool.function.arguments;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  if (!started || !finishReason) {
    yield event('error', { error: { type: 'api_error', message: 'Upstream stream ended without a finish reason' } });
    return;
  }
  if (active) yield event('content_block_stop', { index: active.index });
  for (const tool of tools.values()) {
    if (!tool.id || !tool.name) throw new Error('Incomplete upstream tool identity');
    JSON.parse(tool.arguments || '{}');
    tool.index = nextIndex++;
    yield event('content_block_start', {
      index: tool.index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} },
    });
    yield event('content_block_delta', {
      index: tool.index, delta: { type: 'input_json_delta', partial_json: tool.arguments || '{}' },
    });
    yield event('content_block_stop', { index: tool.index });
  }
  yield event('message_delta', {
    delta: { stop_reason: mapOpenAIFinishReason(finishReason), stop_sequence: null }, usage,
  });
  yield event('message_stop');
}
