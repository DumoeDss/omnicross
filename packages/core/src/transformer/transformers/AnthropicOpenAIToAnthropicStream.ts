/**
 * AnthropicOpenAIToAnthropicStream - OpenAI SSE -> Anthropic event SSE conversion.
 *
 * Internal helper of `./AnthropicStreaming`; do not import the facade here.
 *
 * claude-api-protocol-fidelity (R6) hardening, all scoped to THIS converter (the
 * translation path's synthesizer — the same-format verbatim relay never runs
 * it, so synthesized frames structurally cannot leak into pass-through
 * traffic):
 *  - `message_start` backfills the upstream usage known at emission time;
 *  - in-band `error` events use the official `{"type":"error","error":{…}}`
 *    shape with the upstream text preserved verbatim;
 *  - the finish_reason map carries `content_filter→refusal` (+ `refusal` /
 *    `pause_turn` placeholders) with an observable warning counter;
 *  - a lazy idle-timeout ping heartbeat keeps silent streams alive (Claude
 *    Code's 300s byte watchdog), armed only while idle and cleaned up on
 *    end/error/cancel.
 *
 * @module transformer/transformers/AnthropicOpenAIToAnthropicStream
 */

import type { TransformerContext, TransformerLogger } from '../types';

/** Default synthetic-ping interval (ms). ≤0 disables the heartbeat. */
export const DEFAULT_ANTHROPIC_PING_HEARTBEAT_MS = 20_000;

let anthropicPingHeartbeatMs = DEFAULT_ANTHROPIC_PING_HEARTBEAT_MS;

/**
 * Hot-set the synthetic-ping interval (claude-api-protocol-fidelity §10
 * `anthropic.heartbeatIntervalMs`). Takes effect at each stream's NEXT timer
 * arm — in-flight streams are never interrupted. `undefined`/`NaN` resets to
 * the default; ≤0 disables the heartbeat entirely.
 */
export function setAnthropicPingHeartbeatMs(ms: number | undefined): void {
  anthropicPingHeartbeatMs =
    typeof ms === 'number' && Number.isFinite(ms) ? ms : DEFAULT_ANTHROPIC_PING_HEARTBEAT_MS;
}

/** The current synthetic-ping interval (ms); ≤0 means disabled. */
export function getAnthropicPingHeartbeatMs(): number {
  return anthropicPingHeartbeatMs;
}

/**
 * Observable counter for `content_filter→refusal` remaps (the §9 minimal
 * observability seam — the repo has no metrics registry, so an exported
 * counter + console.warn). Reset only via the test helper.
 */
export let stopReasonContentFilterCount = 0;

/** Test-only counter reset (keeps the exported binding read-only by convention). */
export function __resetStopReasonContentFilterCountForTests(): void {
  stopReasonContentFilterCount = 0;
}

function noteContentFilterRemap(logger?: TransformerLogger): void {
  stopReasonContentFilterCount += 1;
  console.warn(
    `[AnthropicStream] upstream finish_reason=content_filter remapped to stop_reason=refusal (count ${stopReasonContentFilterCount})`,
  );
  logger?.warn?.('upstream finish_reason=content_filter remapped to stop_reason=refusal');
}

/**
 * Classify an upstream in-band error for the official event shape: capacity /
 * overload / server-side signals → `overloaded_error`, everything else →
 * `api_error`. The upstream error text is stringified WHOLE into `message`
 * (recovery flows match on wording — never redact or reword it).
 */
function sniffErrorType(error: unknown): 'overloaded_error' | 'api_error' {
  let text: string;
  try {
    text = JSON.stringify(error) ?? '';
  } catch {
    text = String(error);
  }
  const lower = text.toLowerCase();
  if (
    lower.includes('overload') ||
    lower.includes('capacity') ||
    lower.includes('server_error')
  ) {
    return 'overloaded_error';
  }
  // A server-side status signal (`status` or `code` ≥ 500, numeric or
  // numeric-string) also reads as overload.
  const e = error as { status?: unknown; code?: unknown } | null;
  for (const raw of [e?.status, e?.code]) {
    const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
    if (typeof n === 'number' && Number.isFinite(n) && n >= 500) return 'overloaded_error';
  }
  return 'api_error';
}

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

  // Hoisted so the `cancel()` handler (client disconnect) can reach it.
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  return new ReadableStream({
    start: async (controller) => {
      reader = openaiStream.getReader();
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

      // ── Synthetic ping heartbeat (R6): a LAZY idle timeout, not a resident
      // interval. Armed when the stream opens and re-armed after every chunk;
      // fires only when the upstream goes silent past the configured interval,
      // then re-arms. Cleared on end / error / cancel — a flowing stream never
      // sees a synthesized frame, and a closed stream leaks no timer.
      let pingTimer: ReturnType<typeof setTimeout> | null = null;
      const clearPing = (): void => {
        if (pingTimer !== null) {
          clearTimeout(pingTimer);
          pingTimer = null;
        }
      };
      const armPing = (): void => {
        clearPing();
        const interval = getAnthropicPingHeartbeatMs();
        if (!(interval > 0)) return; // ≤0 → heartbeat disabled
        pingTimer = setTimeout(() => {
          pingTimer = null;
          safeEnqueue(`event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`);
          armPing();
        }, interval);
        // Do not hold the event loop open just for a heartbeat.
        (pingTimer as { unref?: () => void }).unref?.();
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
        armPing();
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
                  error: {
                    type: sniffErrorType(chunk.error),
                    message: JSON.stringify(chunk.error),
                  },
                })}\n\n`);
                continue;
              }

              model = chunk.model || model;

              // Send message start
              if (!hasStarted) {
                hasStarted = true;
                // R6: backfill the usage known AT EMISSION TIME. When the
                // upstream's first (or triggering) chunk carries usage (e.g.
                // include_usage up front), the client sees real input tokens
                // in message_start instead of 0; otherwise 0 stays and the
                // terminal message_delta accumulation covers it (unchanged).
                const startUsage = chunk.usage
                  ? {
                      input_tokens: (chunk.usage.prompt_tokens || 0) -
                        (chunk.usage.prompt_tokens_details?.cached_tokens || 0),
                      output_tokens: chunk.usage.completion_tokens || 0,
                    }
                  : { input_tokens: 0, output_tokens: 0 };
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
                    usage: startUsage,
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
                if (choice.finish_reason === 'content_filter') {
                  noteContentFilterRemap(logger);
                }
                // R6: `content_filter` maps to `refusal` (the Anthropic
                // semantic for refused content — `stop_sequence` was wrong);
                // `refusal` / `pause_turn` are shape-first placeholders for
                // upstreams that emit them natively; unknown values still fall
                // back to `end_turn`.
                const stopReasonMapping: Record<string, string> = {
                  stop: 'end_turn',
                  length: 'max_tokens',
                  tool_calls: 'tool_use',
                  content_filter: 'refusal',
                  refusal: 'refusal',
                  pause_turn: 'pause_turn',
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
          // Chunk fully processed → the stream is not idle; restart the
          // silence clock.
          armPing();
        }
      } catch (e) {
        if (!isClosed) {
          controller.error(e);
        }
      } finally {
        clearPing();
        safeClose();
        reader.releaseLock();
      }
    },
    // R6: client disconnect. Cancelling the upstream reader settles the pending
    // read(), which unblocks the loop's `finally` → `clearPing` — the timer is
    // cleared INDIRECTLY (pinned by the cancel-leak fake-timer test).
    cancel: async () => {
      try {
        await reader?.cancel();
      } catch (_e) {
        // Upstream already closed/errored — nothing to cancel.
      }
    },
  });
}
