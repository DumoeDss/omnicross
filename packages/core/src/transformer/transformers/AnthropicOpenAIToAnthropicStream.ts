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
import { readAnthropicSSE } from './AnthropicSSE';
import { readGoogleReplayContent, type AnthropicReplayContent } from './AnthropicTypes';
import { assertAnthropicChatStreamChunk } from './AnthropicStreamTypes';

import {
  beginAnthropicImageDropScope,
  noteDroppedInlineImages,
} from './utils/anthropicImageDrop';

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
  const encoder = new TextEncoder();
  const reader = openaiStream.getReader();
  let cancelled = false;
  let pingTimer: NodeJS.Timeout | undefined;
  const clearPing = () => { clearTimeout(pingTimer); pingTimer = undefined; };

  return new ReadableStream({
    start: async (controller) => {
      let started = false;
      let failed = false;
      let finished = false;
      let contentIndex = 0;
      let active: { index: number; type: 'thinking' | 'text'; source?: unknown } | undefined;
      const tools = new Map<number, { id: string; name: string; arguments: string; extra_content?: AnthropicReplayContent['extra_content'] }>();
      let pendingGoogleParts: unknown[] = [];
      let stopReason = 'end_turn';
      let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
      const emit = (event: Record<string, unknown>) => {
        if (pendingGoogleParts.length &&
          (event.type === 'content_block_start' || event.type === 'content_block_delta' ||
            event.type === 'content_block_stop' || event.type === 'message_delta')) {
          event.extra_content = { google: { parts: pendingGoogleParts } };
          pendingGoogleParts = [];
        }
        if (!cancelled) controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      };
      const armPing = () => {
        clearPing();
        const interval = getAnthropicPingHeartbeatMs();
        if (cancelled || interval <= 0) return;
        pingTimer = setTimeout(() => { emit({ type: 'ping' }); armPing(); }, interval);
        pingTimer.unref?.();
      };
      const closeBlock = () => {
        if (!active) return;
        emit({ type: 'content_block_stop', index: active.index });
        active = undefined;
      };
      const openBlock = (type: 'thinking' | 'text', source?: unknown) => {
        if (active?.type === type && active.source === source) return;
        closeBlock();
        active = { index: contentIndex++, type, source };
        emit({
          type: 'content_block_start', index: active.index,
          content_block: type === 'thinking' ? { type, thinking: '' } : { type, text: '' },
        });
      };
      try {
        beginAnthropicImageDropScope();
        armPing();
        await readAnthropicSSE(reader, (raw) => {
          if (cancelled) return false;
          const chunk: unknown = raw;
          assertAnthropicChatStreamChunk(chunk);
          armPing();
          const error = chunk.error ?? (chunk.type === 'response.failed' ? chunk.response?.error : undefined);
          if (error) {
            failed = true;
            emit({ type: 'error', error: { type: sniffErrorType(error), message: JSON.stringify(error) } });
            return false;
          }
          if (chunk.usage) {
            usage = {
              input_tokens: (chunk.usage.prompt_tokens || 0) - (chunk.usage.prompt_tokens_details?.cached_tokens || 0),
              output_tokens: chunk.usage.completion_tokens || 0,
              cache_read_input_tokens: chunk.usage.prompt_tokens_details?.cached_tokens || 0,
            };
          }
          if (!started) {
            started = true;
            emit({
              type: 'message_start',
              message: {
                id: chunk.id || `msg_${Date.now()}`, type: 'message', role: 'assistant',
                content: [], model: chunk.model || 'unknown', stop_reason: null, stop_sequence: null, usage,
              },
            });
          }
          if ((chunk.choices?.length ?? 0) > 1 || chunk.choices?.some(choice => choice.index !== undefined && choice.index !== 0)) {
            throw new Error('Multiple Chat candidates cannot be represented by one Anthropic message');
          }
          const choice = chunk.choices?.[0];
          if (!choice) return;
          const delta = choice.delta ?? {};
          const replay = readGoogleReplayContent(delta.extra_content);
          if (replay?.google?.parts) pendingGoogleParts.push(...replay.google.parts);
          if (Array.isArray(delta.images) && delta.images.length) noteDroppedInlineImages(delta.images.length);
          const thinking = typeof delta.thinking === 'string' ? { content: delta.thinking } : delta.thinking;
          const reasoning = thinking?.content ?? delta.reasoning_content;
          if ((typeof reasoning === 'string' && (!replay || reasoning.length > 0)) ||
            (!replay && thinking?.signature !== undefined)) {
            openBlock('thinking', thinking?.index);
            if (typeof reasoning === 'string' && reasoning.length) {
              emit({ type: 'content_block_delta', index: active!.index, delta: { type: 'thinking_delta', thinking: reasoning } });
            }
            if (!replay && typeof thinking?.signature === 'string') {
              emit({ type: 'content_block_delta', index: active!.index, delta: { type: 'signature_delta', signature: thinking.signature } });
            }
          }
          if (thinking?.type === 'redacted_thinking') {
            closeBlock();
            const index = contentIndex++;
            emit({ type: 'content_block_start', index, content_block: { type: 'redacted_thinking', data: thinking.data } });
            emit({ type: 'content_block_stop', index });
          }
          if (thinking?.done) closeBlock();
          if (typeof delta.content === 'string' && delta.content.length) {
            openBlock('text');
            emit({ type: 'content_block_delta', index: active!.index, delta: { type: 'text_delta', text: delta.content } });
          }
          // Chat interleaves argument fragments for parallel calls. Buffer each
          // call until completion so Anthropic blocks never receive deltas after stop.
          for (const tool of delta.tool_calls ?? []) {
            const index = tool.index ?? 0;
            let state = tools.get(index);
            if (!state) {
              state = { id: '', name: '', arguments: '' };
              tools.set(index, state);
            }
            if (tool.id) state.id = tool.id;
            if (tool.function?.name) state.name += tool.function.name;
            if (tool.function?.arguments) state.arguments += tool.function.arguments;
            const toolReplay = readGoogleReplayContent(tool.extra_content);
            if (toolReplay) state.extra_content = toolReplay;
          }
          if (choice.finish_reason) {
            finished = true;
            if (choice.finish_reason === 'content_filter') noteContentFilterRemap(logger);
            const reasons: Record<string, string> = {
              stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use',
              content_filter: 'refusal', refusal: 'refusal', pause_turn: 'pause_turn',
            };
            stopReason = reasons[choice.finish_reason] || 'end_turn';
          }
        }, logger);
        if (!cancelled && !failed) {
          if (!started) throw new Error('Upstream stream ended without a message');
          if (!finished) throw new Error('OpenAI stream ended without finish_reason');
          closeBlock();
          for (const tool of tools.values()) {
            if (!tool.id || !tool.name) throw new Error('Upstream tool call is missing its id or name');
            const index = contentIndex++;
            emit({
              type: 'content_block_start', index,
              content_block: {
                type: 'tool_use', id: tool.id, name: tool.name, input: {},
                ...(tool.extra_content ? { extra_content: tool.extra_content } : {}),
              },
            });
            if (tool.arguments) emit({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: tool.arguments } });
            emit({ type: 'content_block_stop', index });
          }
          emit({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage });
          emit({ type: 'message_stop' });
        }
        if (!cancelled) controller.close();
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        if (!cancelled) controller.error(error);
      } finally {
        clearPing();
        reader.releaseLock();
      }
    },
    cancel: async (reason) => {
      cancelled = true;
      clearPing();
      await reader.cancel(reason);
    },
  });
}
