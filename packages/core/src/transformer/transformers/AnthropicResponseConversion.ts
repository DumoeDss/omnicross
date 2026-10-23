/**
 * AnthropicResponseConversion - Non-streaming RESPONSE-DIRECTION conversions
 * between Anthropic and OpenAI/unified message shapes.
 *
 * Internal helper of AnthropicConversion; do not import the facade here.
 *
 * @module transformer/transformers/AnthropicResponseConversion
 */

import { anthropicUsageToChatUsage } from './utils/usage-mapping';
import { formatAnthropicWebSources, readGoogleReplayContent } from './AnthropicTypes';

import {
  beginAnthropicImageDropScope,
  noteDroppedInlineImages,
} from './utils/anthropicImageDrop';

/**
 * Convert Anthropic non-streaming response to OpenAI-compatible format.
 * Reverse of `convertOpenAIResponseToAnthropic`.
 */
export function convertAnthropicResponseToOpenAI(
  anthropicResponse: Record<string, unknown>
): Record<string, unknown> {
  const content = (anthropicResponse.content as Array<Record<string, unknown>>) || [];
  const textParts: string[] = [];
  const toolUses = content.filter(c => c.type === 'tool_use');
  const thinkingBlocks = content.filter(c => c.type === 'thinking' || c.type === 'redacted_thinking');
  for (const block of content) {
    if (block.type === 'text') {
      textParts.push(String(block.text ?? ''));
      if (Array.isArray(block.citations) && block.citations.length) {
        textParts.push(`\n${formatAnthropicWebSources(block.citations)}`);
      }
    } else if (block.type === 'web_search_tool_result') {
      textParts.push(`\n${formatAnthropicWebSources(block.content)}`);
    } else if (block.type === 'server_tool_use' && block.name === 'web_search' &&
      content.some(result => result.type === 'web_search_tool_result' && result.tool_use_id === block.id)) {
      // Already executed by the provider; never ask the downstream client to execute it again.
    } else if (!['tool_use', 'thinking', 'redacted_thinking'].includes(String(block.type))) {
      throw new Error(`Unsupported Anthropic response block: ${block.type}`);
    }
  }

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: textParts.join('') || null,
  };
  const googleParts = content.flatMap(block => readGoogleReplayContent(block.extra_content)?.google?.parts ?? []);
  if (googleParts.length) message.extra_content = { google: { parts: googleParts } };

  if (toolUses.length > 0) {
    message.tool_calls = toolUses.map(tc => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.input || {}),
      },
      ...(tc.extra_content ? { extra_content: readGoogleReplayContent(tc.extra_content) } : {}),
    }));
  }

  if (thinkingBlocks.length) {
    message.thinking = {
      content: thinkingBlocks.filter(block => block.type === 'thinking').map(block => block.thinking).join(''),
      blocks: thinkingBlocks,
      ...(thinkingBlocks.length === 1 && thinkingBlocks[0].signature ? { signature: thinkingBlocks[0].signature } : {}),
    };
  }

  const stopReasonMapping: Record<string, string> = {
    end_turn: 'stop',
    max_tokens: 'length',
    tool_use: 'tool_calls',
    stop_sequence: 'stop',
    refusal: 'content_filter',
    pause_turn: 'pause_turn',
  };

  const usage = anthropicResponse.usage as Record<string, unknown> | undefined;

  return {
    id: anthropicResponse.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anthropicResponse.model || 'unknown',
    choices: [{
      index: 0,
      message,
      finish_reason: stopReasonMapping[anthropicResponse.stop_reason as string] || 'stop',
    }],
    // Preserve prompt-cache counts (cache-read → prompt_tokens_details.cached_tokens,
    // cache-creation folded into prompt_tokens) instead of dropping them.
    usage: anthropicUsageToChatUsage(usage),
  };
}

/**
 * Convert OpenAI non-streaming response to Anthropic format.
 */
export function convertOpenAIResponseToAnthropic(
  openaiResponse: Record<string, unknown>
): Record<string, unknown> {
  if (Array.isArray(openaiResponse.choices) && openaiResponse.choices.length > 1) {
    throw new Error('Multiple Chat candidates cannot be represented by one Anthropic message');
  }
  const choice = (openaiResponse.choices as Array<Record<string, unknown>>)?.[0];
  if (!choice) {
    throw new Error('No choices found in OpenAI response');
  }

  const message = choice.message as Record<string, unknown>;
  const replay = readGoogleReplayContent(message.extra_content);
  const content: Array<Record<string, unknown>> = [];

  // Honest boundary (chat-inline-images): the Anthropic Messages wire has no
  // image output block, so session images are DROPPED here — never base64-
  // stuffed into text. The drop is recorded as a bounded count only.
  const images = message.images as unknown[] | undefined;
  if (Array.isArray(images) && images.length > 0) {
    beginAnthropicImageDropScope();
    noteDroppedInlineImages(images.length);
  }

  // Handle thinking — MUST precede text and tool_use blocks in Anthropic
  // format (the Anthropic API enforces block ordering: thinking → text →
  // tool_use). Mirrors `buildAnthropicRequestBody`'s ordering.
  const thinking = message.thinking as Record<string, unknown> | undefined;
  if (Array.isArray(thinking?.blocks)) {
    content.push(...thinking.blocks);
  } else {
    const reasoning = thinking?.content ?? message.reasoning_content;
    if (typeof reasoning === 'string' && (!replay || reasoning.length > 0)) {
      content.push({
        type: 'thinking', thinking: reasoning,
        ...(!replay && typeof thinking?.signature === 'string' ? { signature: thinking.signature } : {}),
      });
    }
  }

  if (typeof message.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type !== 'text') throw new Error(`Unsupported Anthropic response content block: ${part.type}`);
      content.push({ ...part });
    }
  }

  // Handle tool calls
  const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
  if (toolCalls?.length) {
    for (const toolCall of toolCalls) {
      const func = toolCall.function as Record<string, unknown>;
      let parsedInput: Record<string, unknown> = {};
      try {
        const args = func.arguments as string;
        parsedInput = typeof args === 'string' ? JSON.parse(args) : args;
      } catch {
        throw new Error(`Invalid JSON arguments for Anthropic tool ${func.name}`);
      }

      const toolReplay = readGoogleReplayContent(toolCall.extra_content);
      content.push({
        type: 'tool_use',
        id: toolCall.id,
        name: func.name,
        input: parsedInput,
        ...(toolReplay ? { extra_content: toolReplay } : {}),
      });
    }
  }

  // A namespaced gateway extension preserves foreign signatures without
  // pretending they are Anthropic signatures. Standard SDKs may strip it.
  if (replay && content.length) {
    const existing = readGoogleReplayContent(content[0].extra_content);
    content[0].extra_content = { google: { ...existing?.google, ...replay.google } };
  }

  // Map finish reason
  const finishReason = choice.finish_reason as string;
  const stopReasonMapping: Record<string, string> = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
    content_filter: 'refusal',
    refusal: 'refusal',
    pause_turn: 'pause_turn',
  };

  const usage = openaiResponse.usage as Record<string, unknown> | undefined;
  const usageDetails = usage?.prompt_tokens_details as Record<string, unknown> | undefined;

  return {
    id: openaiResponse.id,
    type: 'message',
    role: 'assistant',
    model: openaiResponse.model,
    content,
    stop_reason: stopReasonMapping[finishReason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: ((usage?.prompt_tokens as number) || 0) -
        ((usageDetails?.cached_tokens as number) || 0),
      output_tokens: (usage?.completion_tokens as number) || 0,
      cache_read_input_tokens: (usageDetails?.cached_tokens as number) || 0,
    },
  };
}
