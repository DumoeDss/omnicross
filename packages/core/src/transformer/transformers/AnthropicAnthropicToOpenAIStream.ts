/**
 * AnthropicAnthropicToOpenAIStream - Anthropic event SSE -> OpenAI SSE conversion.
 *
 * Internal helper of `./AnthropicStreaming`; do not import the facade here.
 *
 * @module transformer/transformers/AnthropicAnthropicToOpenAIStream
 */

import type { TransformerLogger } from '../types';

/**
 * Convert Anthropic SSE event stream to OpenAI SSE chunk stream.
 * Reverse of `convertOpenAIStreamToAnthropic`.
 */
export function convertAnthropicStreamToOpenAI(
  anthropicStream: ReadableStream<Uint8Array>,
  logger?: TransformerLogger
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Track active tool calls for building OpenAI tool_calls deltas
  const activeToolCalls = new Map<number, { id: string; name: string; index: number }>();
  let toolCallCounter = 0;
  let model = 'unknown';
  let messageId = `chatcmpl-${Date.now()}`;

  return new ReadableStream({
    start: async (controller) => {
      const reader = anthropicStream.getReader();
      let buffer = '';
      let isClosed = false;

      const safeEnqueue = (data: string) => {
        if (!isClosed) {
          try {
            controller.enqueue(encoder.encode(data));
          } catch {
            isClosed = true;
          }
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (isClosed) break;
            if (!line.startsWith('data:')) continue;

            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;

            try {
              const event = JSON.parse(data);

              // message_start → extract model and message ID
              if (event.type === 'message_start' && event.message) {
                model = event.message.model || model;
                messageId = event.message.id || messageId;
              }

              // content_block_delta → convert to OpenAI delta
              if (event.type === 'content_block_delta' && event.delta) {
                const chunk: Record<string, unknown> = {
                  id: messageId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [{ index: 0, delta: {}, finish_reason: null }],
                };
                const delta = (chunk.choices as Array<Record<string, unknown>>)[0].delta as Record<string, unknown>;

                if (event.delta.type === 'text_delta') {
                  delta.content = event.delta.text;
                } else if (event.delta.type === 'input_json_delta') {
                  const toolInfo = activeToolCalls.get(event.index);
                  if (toolInfo) {
                    delta.tool_calls = [{
                      index: toolInfo.index,
                      function: { arguments: event.delta.partial_json },
                    }];
                  }
                } else if (event.delta.type === 'thinking_delta') {
                  delta.thinking = { content: event.delta.thinking };
                } else if (event.delta.type === 'signature_delta') {
                  delta.thinking = { signature: event.delta.signature };
                } else {
                  continue; // skip unknown delta types
                }

                safeEnqueue(`data: ${JSON.stringify(chunk)}\n\n`);
              }

              // content_block_start → start tool_use or server_tool_use block
              if (event.type === 'content_block_start' && event.content_block) {
                if (event.content_block.type === 'tool_use' || event.content_block.type === 'server_tool_use') {
                  const tcIndex = toolCallCounter++;
                  activeToolCalls.set(event.index, {
                    id: event.content_block.id,
                    name: event.content_block.name,
                    index: tcIndex,
                  });
                  const chunk: Record<string, unknown> = {
                    id: messageId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                      index: 0,
                      delta: {
                        tool_calls: [{
                          index: tcIndex,
                          id: event.content_block.id,
                          type: 'function',
                          function: { name: event.content_block.name, arguments: '' },
                        }],
                      },
                      finish_reason: null,
                    }],
                  };
                  safeEnqueue(`data: ${JSON.stringify(chunk)}\n\n`);
                } else if (event.content_block.type === 'web_search_tool_result') {
                  // Web search results — format as text content
                  const searches = event.content_block.content as Array<Record<string, unknown>> | undefined;
                  if (searches?.length) {
                    const formatted = searches
                      .map((s: Record<string, unknown>) =>
                        `[${s.title}](${s.url}): ${s.page_content || s.snippet || ''}`)
                      .join('\n');
                    const chunk: Record<string, unknown> = {
                      id: messageId,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model,
                      choices: [{
                        index: 0,
                        delta: { content: `\n\n**Search Results:**\n${formatted}` },
                        finish_reason: null,
                      }],
                    };
                    safeEnqueue(`data: ${JSON.stringify(chunk)}\n\n`);
                  }
                }
              }

              // message_delta → finish reason + usage
              if (event.type === 'message_delta' && event.delta) {
                const stopReasonMapping: Record<string, string> = {
                  end_turn: 'stop',
                  max_tokens: 'length',
                  tool_use: 'tool_calls',
                  stop_sequence: 'stop',
                };
                const chunk: Record<string, unknown> = {
                  id: messageId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: stopReasonMapping[event.delta.stop_reason] || 'stop',
                  }],
                };
                if (event.usage) {
                  chunk.usage = {
                    prompt_tokens: event.usage.input_tokens || 0,
                    completion_tokens: event.usage.output_tokens || 0,
                    total_tokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0),
                  };
                }
                safeEnqueue(`data: ${JSON.stringify(chunk)}\n\n`);
              }
            } catch (e) {
              logger?.error('Error parsing Anthropic stream event:', e);
            }
          }
        }
      } catch (e) {
        if (!isClosed) {
          controller.error(e);
        }
      } finally {
        // Send [DONE] marker
        safeEnqueue('data: [DONE]\n\n');
        if (!isClosed) {
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }
        reader.releaseLock();
      }
    },
  });
}
