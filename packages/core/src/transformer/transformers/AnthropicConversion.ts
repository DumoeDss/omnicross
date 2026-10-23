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

import type { MessageContent, UnifiedChatRequest, UnifiedMessage } from '../types';
import { normalizeThinkLevel } from '../reasoning-effort';

import { convertAnthropicToolsToOpenAI, isNativeAnthropicTool } from './AnthropicToolHandling';
import type {
  AnthropicContent,
  AnthropicRequest,
  AnthropicTextContent,
  AnthropicToolResultContent,
  AnthropicToolUseContent,
} from './AnthropicTypes';
import { formatBase64, getThinkLevel } from './AnthropicTypes';

function decodeContentPart(part: AnthropicContent): MessageContent {
  if (part.type === 'text') {
    return { type: 'text', text: part.text, ...(part.cache_control ? { cache_control: part.cache_control } : {}) };
  }
  if (part.type === 'image') {
    return {
      type: 'image_url',
      image_url: { url: part.source.type === 'base64'
        ? formatBase64(part.source.data || '', part.source.media_type)
        : part.source.url || '' },
      media_type: part.source.media_type,
    };
  }
  throw new Error(`Unsupported Anthropic content block: ${part.type}`);
}

export { buildAnthropicRequestBody } from './AnthropicRequestBuilder';
export {
  convertAnthropicResponseToOpenAI,
  convertOpenAIResponseToAnthropic,
} from './AnthropicResponseConversion';

// Claude Code can send system turns inside messages as well as the top-level system field.
type AnthropicIngressRequest = Omit<AnthropicRequest, 'messages'> & {
  messages: Array<AnthropicRequest['messages'][number] | {
    role: 'system';
    content: string | AnthropicContent[];
  }>;
};

/**
 * Transform an Anthropic Messages API request body to the unified request shape.
 * (Reverse direction of `buildAnthropicRequestBody`.)
 */
export function transformAnthropicRequestToUnified(request: unknown): UnifiedChatRequest {
  const anthropicRequest = request as AnthropicIngressRequest;
  const messages: UnifiedMessage[] = [];

  // Handle system message
  if (anthropicRequest.system) {
    if (typeof anthropicRequest.system === 'string') {
      messages.push({
        role: 'system',
        content: anthropicRequest.system,
      });
    } else if (Array.isArray(anthropicRequest.system)) {
      const textParts = anthropicRequest.system.map((item) => {
        if (item.type !== 'text') throw new Error('Anthropic system messages only support text');
        return {
          type: 'text' as const,
          text: item.text,
          cache_control: item.cache_control as { type?: string } | undefined,
        };
      });
      if (textParts.length > 0) {
        messages.push({
          role: 'system',
          content: textParts,
        });
      }
    }
  }

  // Process messages
  const requestMessages = anthropicRequest.messages || [];

  for (const msg of requestMessages) {
    if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'system') {
      throw new Error(`Unsupported Anthropic message role: ${msg.role}`);
    }

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
      if (msg.role === 'system') {
        messages.push({
          role: 'system',
          content: msg.content.map((part) => {
            if (part.type !== 'text') throw new Error('Anthropic system messages only support text');
            return decodeContentPart(part);
          }),
        });
      } else if (msg.role === 'user') {
        // Handle tool results
        const toolParts = msg.content.filter(
          (c): c is AnthropicToolResultContent => c.type === 'tool_result'
        );
        for (const tool of toolParts) {
          if (!tool.tool_use_id) throw new Error('Anthropic tool_result requires tool_use_id');
          messages.push({
            role: 'tool',
            content: Array.isArray(tool.content)
              ? (tool.content as AnthropicContent[]).map(decodeContentPart)
              : tool.content ?? '',
            tool_call_id: tool.tool_use_id,
            cache_control: tool.cache_control,
            ...(tool.is_error !== undefined ? { is_error: tool.is_error } : {}),
          });
        }

        const textAndMediaParts = msg.content.filter((c) => c.type !== 'tool_result');
        if (textAndMediaParts.length > 0) {
          messages.push({
            role: 'user',
            content: textAndMediaParts.map(decodeContentPart),
          });
        }
      } else if (msg.role === 'assistant') {
        const assistantMessage: UnifiedMessage = {
          role: 'assistant',
          content: '',
        };

        const textParts = msg.content.filter((c): c is AnthropicTextContent => c.type === 'text');
        if (textParts.length > 0) {
          assistantMessage.content = textParts.map(decodeContentPart);
        }

        // Extract tool calls
        const toolCallParts = msg.content.filter(
          (c): c is AnthropicToolUseContent => c.type === 'tool_use'
        );
        if (toolCallParts.length > 0) {
          for (const tool of toolCallParts) {
            if (!tool.id || !tool.name) throw new Error('Anthropic tool_use requires id and name');
          }
          assistantMessage.tool_calls = toolCallParts.map((tool) => ({
            id: tool.id,
            type: 'function' as const,
            function: {
              name: tool.name,
              arguments: JSON.stringify(tool.input || {}),
            },
            ...(typeof tool.extra_content?.google?.thought_signature === 'string'
              ? { extra_content: { google: { thought_signature: tool.extra_content.google.thought_signature } } } : {}),
          }));
        }

        const blocks = msg.content.filter(
          (block) => block.type === 'thinking' || block.type === 'redacted_thinking'
        ).map((block) => block.type === 'thinking'
          ? { type: 'thinking' as const, thinking: block.thinking, ...(block.signature ? { signature: block.signature } : {}) }
          : { type: 'redacted_thinking' as const, data: block.data });
        if (blocks.length > 0) {
          assistantMessage.thinking = {
            content: blocks.filter((block) => block.type === 'thinking').map((block) => block.thinking).join(''),
            blocks,
            ...(blocks.length === 1 && blocks[0].type === 'thinking' && blocks[0].signature
              ? { signature: blocks[0].signature } : {}),
          };
        }
        const googleParts = msg.content.flatMap((block) =>
          Array.isArray(block.extra_content?.google?.parts) ? block.extra_content.google.parts : []);
        if (googleParts.length) {
          Object.assign(assistantMessage, { extra_content: { google: { parts: googleParts } } });
        }
        for (const block of msg.content) {
          if (!['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(block.type)) {
            throw new Error(`Unsupported Anthropic assistant content block: ${block.type}`);
          }
        }

        messages.push(assistantMessage);
      }
    }
  }

  // Native tools have provider-defined schemas, whether executed by the server
  // or client. Preserve their declarations rather than invent function schemas.
  const rawTools = (anthropicRequest.tools || []) as Array<Record<string, unknown>>;
  const serverSideTools = rawTools.filter(isNativeAnthropicTool);
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
      if (anthropicRequest.output_config?.effort !== undefined && !effort) {
        throw new Error(`Unsupported Anthropic effort: ${anthropicRequest.output_config.effort}`);
      }
      result.reasoning = { effort: effort ?? 'high', enabled: effort !== 'none' };
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
      result.tool_choice = anthropicRequest.tool_choice.type === 'any' ? 'required' : anthropicRequest.tool_choice.type;
    }
    if (anthropicRequest.tool_choice.disable_parallel_tool_use !== undefined) {
      result.parallel_tool_calls = !anthropicRequest.tool_choice.disable_parallel_tool_use;
    }
  }

  return result;
}
