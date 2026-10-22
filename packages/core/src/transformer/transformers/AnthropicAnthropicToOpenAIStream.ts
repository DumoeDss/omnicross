/**
 * AnthropicAnthropicToOpenAIStream - Anthropic event SSE -> OpenAI SSE conversion.
 *
 * Internal helper of `./AnthropicStreaming`; do not import the facade here.
 *
 * @module transformer/transformers/AnthropicAnthropicToOpenAIStream
 */

import type { TransformerLogger } from '../types';

import { anthropicUsageToChatUsage } from './utils/usage-mapping';
import { readAnthropicSSE } from './AnthropicSSE';
import { formatAnthropicWebSources, readGoogleReplayContent } from './AnthropicTypes';
import { assertAnthropicWireStreamEvent } from './AnthropicStreamTypes';

/**
 * Convert Anthropic SSE event stream to OpenAI SSE chunk stream.
 * Reverse of `convertOpenAIStreamToAnthropic`.
 */
export function convertAnthropicStreamToOpenAI(
  anthropicStream: ReadableStream<Uint8Array>,
  logger?: TransformerLogger
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const reader = anthropicStream.getReader();
  let cancelled = false;
  return new ReadableStream({
    start: async (controller) => {
      const tools = new Map<number, { index: number; hasInput: boolean }>();
      const thinkingBlocks = new Set<number>();
      const serverSearchBlocks = new Set<number>();
      const pendingSearches = new Set<string>();
      let model = 'unknown';
      let id = `chatcmpl-${Date.now()}`;
      let usage: Record<string, unknown> = {};
      let failed = false;
      let finished = false;
      const emit = (delta: Record<string, unknown>, finishReason: string | null = null, includeUsage = false) => {
        if (cancelled) return;
        const chunk = {
          id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(includeUsage ? { usage: anthropicUsageToChatUsage(usage) } : {}),
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      };
      try {
        await readAnthropicSSE(reader, (event) => {
          if (cancelled) return false;
          assertAnthropicWireStreamEvent(event);
          if (event.type === 'error') {
            failed = true;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: event.error })}\n\n`));
            return false;
          }
          const eventReplay = readGoogleReplayContent(event.extra_content);
          if (eventReplay?.google?.parts) emit({ extra_content: { google: { parts: eventReplay.google.parts } } });
          const blockReplay = readGoogleReplayContent(event.type === 'content_block_start' ? event.content_block.extra_content : undefined);
          if (blockReplay?.google?.parts) emit({ extra_content: { google: { parts: blockReplay.google.parts } } });
          if (event.type === 'message_start') {
            model = event.message.model || model;
            id = event.message.id || id;
            usage = { ...event.message.usage };
            emit({ role: 'assistant' });
          } else if (event.type === 'content_block_start') {
            const block = event.content_block;
            if (block.type === 'tool_use') {
              const index = tools.size;
              tools.set(event.index, { index, hasInput: !!block.input && Object.keys(block.input).length > 0 });
              emit({ tool_calls: [{
                index, id: block.id, type: 'function',
                function: { name: block.name, arguments: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : '' },
                ...(block.extra_content ? { extra_content: readGoogleReplayContent(block.extra_content) } : {}),
              }] });
            } else if (block.type === 'text') {
              if (block.text) emit({ content: block.text });
              if (block.citations?.length) emit({ content: `\n${formatAnthropicWebSources(block.citations)}` });
            } else if (block.type === 'thinking') {
              thinkingBlocks.add(event.index);
              emit({ thinking: { index: event.index, content: block.thinking ?? '', ...(block.signature ? { signature: block.signature } : {}) } });
            } else if (block.type === 'redacted_thinking') {
              emit({ thinking: { index: event.index, type: block.type, data: block.data } });
            } else if (block.type === 'server_tool_use' && block.name === 'web_search') {
              serverSearchBlocks.add(event.index);
              pendingSearches.add(block.id);
            } else if (block.type === 'web_search_tool_result') {
              emit({ content: `\n${formatAnthropicWebSources(block.content)}` });
              pendingSearches.delete(block.tool_use_id);
            } else {
              throw new Error(`Unsupported Anthropic response block: ${block.type}`);
            }
          } else if (event.type === 'content_block_delta') {
            const delta = event.delta;
            if (delta.type === 'text_delta') emit({ content: delta.text });
            else if (delta.type === 'thinking_delta') emit({ thinking: { index: event.index, content: delta.thinking } });
            else if (delta.type === 'signature_delta') emit({ thinking: { index: event.index, signature: delta.signature } });
            else if (delta.type === 'citations_delta') emit({ content: `\n${formatAnthropicWebSources([delta.citation])}` });
            else if (delta.type === 'input_json_delta') {
              if (serverSearchBlocks.has(event.index)) return;
              const tool = tools.get(event.index);
              if (!tool) throw new Error('Anthropic tool delta has no tool start');
              if (delta.partial_json) tool.hasInput = true;
              emit({ tool_calls: [{ index: tool.index, function: { arguments: delta.partial_json } }] });
            }
          } else if (event.type === 'content_block_stop') {
            if (thinkingBlocks.delete(event.index)) emit({ thinking: { index: event.index, done: true } });
            const tool = tools.get(event.index);
            if (tool && !tool.hasInput) {
              tool.hasInput = true;
              emit({ tool_calls: [{ index: tool.index, function: { arguments: '{}' } }] });
            }
          } else if (event.type === 'message_delta') {
            if (pendingSearches.size) throw new Error('Anthropic web search ended without a result');
            usage = { ...usage, ...event.usage };
            const reasons: Record<string, string> = {
              end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls',
              stop_sequence: 'stop', refusal: 'content_filter', pause_turn: 'pause_turn',
            };
            emit({}, reasons[event.delta.stop_reason ?? ''] || 'stop', true);
          } else if (event.type === 'message_stop') {
            finished = true;
            return false;
          }
        }, logger);
        if (!failed && pendingSearches.size) throw new Error('Anthropic web search ended without a result');
        if (!cancelled) {
          if (!failed && !finished) throw new Error('Anthropic stream ended without message_stop');
          if (!failed) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        if (!cancelled) controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    cancel: async (reason) => {
      cancelled = true;
      await reader.cancel(reason);
    },
  });
}
