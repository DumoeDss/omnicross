/**
 * AnthropicOpenAIToAnthropicStream - OpenAI SSE -> Anthropic event SSE conversion.
 *
 * Internal helper of `./AnthropicStreaming`; do not import the facade here.
 *
 * @module transformer/transformers/AnthropicOpenAIToAnthropicStream
 */

import type { TransformerContext, TransformerLogger } from '../types';

/**
 * Convert OpenAI SSE stream to Anthropic event stream.
 *
 * Accepts an optional `logger` for non-fatal parse-error reporting (matches
 * the AnthropicTransformer facade's previous `this.logger?.error` behaviour).
 */
export function convertOpenAIStreamToAnthropic(
  openaiStream: ReadableStream<Uint8Array>,
  _context?: TransformerContext,
  logger?: TransformerLogger
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let hasStarted = false;
  let hasTextContentStarted = false;
  let isThinkingStarted = false;
  let contentIndex = 0;
  let currentContentBlockIndex = -1;
  const toolCallIndexToContentBlockIndex = new Map<number, number>();

  return new ReadableStream({
    start: async (controller) => {
      const reader = openaiStream.getReader();
      let buffer = '';
      const messageId = `msg_${Date.now()}`;
      let model = 'unknown';
      let isClosed = false;
      let stopReasonDelta: Record<string, unknown> | null = null;

      const safeEnqueue = (data: string) => {
        if (!isClosed) {
          try {
            controller.enqueue(encoder.encode(data));
          } catch (_e) {
            isClosed = true;
          }
        }
      };

      const assignContentBlockIndex = (): number => {
        return contentIndex++;
      };

      const safeClose = () => {
        if (isClosed) return;

        // Close any open content block
        if (currentContentBlockIndex >= 0) {
          safeEnqueue(`event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: currentContentBlockIndex,
          })}\n\n`);
        }

        // Send message delta
        if (stopReasonDelta) {
          safeEnqueue(`event: message_delta\ndata: ${JSON.stringify(stopReasonDelta)}\n\n`);
        } else {
          safeEnqueue(`event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { input_tokens: 0, output_tokens: 0 },
          })}\n\n`);
        }

        // Send message stop
        safeEnqueue(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);

        try {
          controller.close();
        } catch (_e) {
          // Already closed
        }
        isClosed = true;
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
            if (data === '[DONE]') continue;

            try {
              const chunk = JSON.parse(data);

              if (chunk.error) {
                safeEnqueue(`event: error\ndata: ${JSON.stringify({
                  type: 'error',
                  message: { type: 'api_error', message: JSON.stringify(chunk.error) },
                })}\n\n`);
                continue;
              }

              model = chunk.model || model;

              // Send message start
              if (!hasStarted) {
                hasStarted = true;
                safeEnqueue(`event: message_start\ndata: ${JSON.stringify({
                  type: 'message_start',
                  message: {
                    id: messageId,
                    type: 'message',
                    role: 'assistant',
                    content: [],
                    model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 },
                  },
                })}\n\n`);
              }

              const choice = chunk.choices?.[0];
              if (!choice) continue;

              // Update usage for stop reason
              if (chunk.usage) {
                stopReasonDelta = {
                  type: 'message_delta',
                  delta: { stop_reason: 'end_turn', stop_sequence: null },
                  usage: {
                    input_tokens: (chunk.usage.prompt_tokens || 0) -
                      (chunk.usage.prompt_tokens_details?.cached_tokens || 0),
                    output_tokens: chunk.usage.completion_tokens || 0,
                    cache_read_input_tokens: chunk.usage.prompt_tokens_details?.cached_tokens || 0,
                  },
                };
              }

              // Handle thinking content
              if (choice.delta?.thinking) {
                if (!isThinkingStarted) {
                  const thinkingBlockIndex = assignContentBlockIndex();
                  safeEnqueue(`event: content_block_start\ndata: ${JSON.stringify({
                    type: 'content_block_start',
                    index: thinkingBlockIndex,
                    content_block: { type: 'thinking', thinking: '' },
                  })}\n\n`);
                  currentContentBlockIndex = thinkingBlockIndex;
                  isThinkingStarted = true;
                }

                if (choice.delta.thinking.signature) {
                  safeEnqueue(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: currentContentBlockIndex,
                    delta: { type: 'signature_delta', signature: choice.delta.thinking.signature },
                  })}\n\n`);
                  safeEnqueue(`event: content_block_stop\ndata: ${JSON.stringify({
                    type: 'content_block_stop',
                    index: currentContentBlockIndex,
                  })}\n\n`);
                  currentContentBlockIndex = -1;
                } else if (choice.delta.thinking.content) {
                  safeEnqueue(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: currentContentBlockIndex,
                    delta: { type: 'thinking_delta', thinking: choice.delta.thinking.content },
                  })}\n\n`);
                }
              }

              // Handle text content
              if (choice.delta?.content) {
                if (!hasTextContentStarted) {
                  // Close thinking block if open
                  if (currentContentBlockIndex >= 0 && isThinkingStarted) {
                    safeEnqueue(`event: content_block_stop\ndata: ${JSON.stringify({
                      type: 'content_block_stop',
                      index: currentContentBlockIndex,
                    })}\n\n`);
                  }

                  hasTextContentStarted = true;
                  const textBlockIndex = assignContentBlockIndex();
                  safeEnqueue(`event: content_block_start\ndata: ${JSON.stringify({
                    type: 'content_block_start',
                    index: textBlockIndex,
                    content_block: { type: 'text', text: '' },
                  })}\n\n`);
                  currentContentBlockIndex = textBlockIndex;
                }

                safeEnqueue(`event: content_block_delta\ndata: ${JSON.stringify({
                  type: 'content_block_delta',
                  index: currentContentBlockIndex,
                  delta: { type: 'text_delta', text: choice.delta.content },
                })}\n\n`);
              }

              // Handle tool calls
              if (choice.delta?.tool_calls) {
                for (const toolCall of choice.delta.tool_calls) {
                  const toolCallIndex = toolCall.index ?? 0;

                  if (!toolCallIndexToContentBlockIndex.has(toolCallIndex)) {
                    // Close previous content block
                    if (currentContentBlockIndex >= 0) {
                      safeEnqueue(`event: content_block_stop\ndata: ${JSON.stringify({
                        type: 'content_block_stop',
                        index: currentContentBlockIndex,
                      })}\n\n`);
                      hasTextContentStarted = false;
                    }

                    const newBlockIndex = assignContentBlockIndex();
                    toolCallIndexToContentBlockIndex.set(toolCallIndex, newBlockIndex);

                    safeEnqueue(`event: content_block_start\ndata: ${JSON.stringify({
                      type: 'content_block_start',
                      index: newBlockIndex,
                      content_block: {
                        type: 'tool_use',
                        id: toolCall.id || `call_${Date.now()}_${toolCallIndex}`,
                        name: toolCall.function?.name || `tool_${toolCallIndex}`,
                        input: {},
                      },
                    })}\n\n`);
                    currentContentBlockIndex = newBlockIndex;
                  }

                  if (toolCall.function?.arguments) {
                    const blockIndex = toolCallIndexToContentBlockIndex.get(toolCallIndex);
                    if (blockIndex !== undefined) {
                      safeEnqueue(`event: content_block_delta\ndata: ${JSON.stringify({
                        type: 'content_block_delta',
                        index: blockIndex,
                        delta: { type: 'input_json_delta', partial_json: toolCall.function.arguments },
                      })}\n\n`);
                    }
                  }
                }
              }

              // Handle finish reason
              if (choice.finish_reason) {
                const stopReasonMapping: Record<string, string> = {
                  stop: 'end_turn',
                  length: 'max_tokens',
                  tool_calls: 'tool_use',
                  content_filter: 'stop_sequence',
                };

                stopReasonDelta = {
                  type: 'message_delta',
                  delta: {
                    stop_reason: stopReasonMapping[choice.finish_reason] || 'end_turn',
                    stop_sequence: null,
                  },
                  usage: {
                    input_tokens: (chunk.usage?.prompt_tokens || 0) -
                      (chunk.usage?.prompt_tokens_details?.cached_tokens || 0),
                    output_tokens: chunk.usage?.completion_tokens || 0,
                    cache_read_input_tokens: chunk.usage?.prompt_tokens_details?.cached_tokens || 0,
                  },
                };
              }
            } catch (e) {
              logger?.error('Error parsing stream chunk:', e);
            }
          }
        }
      } catch (e) {
        if (!isClosed) {
          controller.error(e);
        }
      } finally {
        safeClose();
        reader.releaseLock();
      }
    },
  });
}
