/**
 * sse.ts — encode BridgeEvents as OpenAI Responses SSE (or one JSON response).
 *
 * Trimmed port of codex-chatgpt-web's bridge.ts streaming encoder, restricted
 * to what a browser-only (no tool calls) adapter can emit: assistant messages,
 * reasoning summaries, terminal completed/incomplete/failed frames, plus a
 * real `response.heartbeat` during upstream silence so Codex's idle timer is
 * re-armed while a long browser turn thinks. A compaction turn emits exactly
 * one synthetic `{type:"compaction", encrypted_content:"ocx1:…"}` output item
 * before response.completed (codex-rs requires exactly one).
 *
 * @module @omnicross/chatgpt-web/bridge/sse
 */

import { encodeCompactionSummary } from './compaction';
import type { BridgeEvent, BridgeUsage } from './types';

function uuid(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function sseEvent(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function responsesUsage(usage: BridgeUsage | undefined): Record<string, unknown> {
  if (!usage) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
  };
}

export interface ResponsesSseOptions {
  responseId?: string;
  hideThinkingSummary?: boolean;
  /** Compaction turn: suppress the visible message, emit one compaction item. */
  compaction?: boolean;
  heartbeatMs?: number;
  /** Adapter silence ceiling before the turn is cut as hung. */
  stallTimeoutMs?: number;
  /** Test seams. */
  now?: () => number;
}

/** Convert an adapter event stream into a Responses SSE byte stream. */
export function bridgeToResponsesSSE(
  events: AsyncIterable<BridgeEvent>,
  modelId: string,
  options: ResponsesSseOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const responseId = options.responseId ?? `resp_${uuid()}`;
  const heartbeatMs = options.heartbeatMs ?? 2_000;
  const stallTimeoutMs = options.stallTimeoutMs ?? 300_000;
  const now = options.now ?? (() => Date.now());
  let seq = 0;
  let closed = false;
  let terminated = false;
  let lastEventAt = now();
  let beat: ReturnType<typeof setInterval> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const createdAt = Math.floor(Date.now() / 1000);
  let outputIndex = 0;
  const finishedItems: Array<Record<string, unknown>> = [];
  let currentMsg: { itemId: string; outputIndex: number; text: string } | null = null;
  let currentReasoning: { itemId: string; outputIndex: number; text: string } | null = null;
  let currentToolCall: { itemId: string; outputIndex: number; callId: string; name: string; args: string; freeform?: boolean } | null = null;
  let compactionText = '';
  let hiddenThinkingText = '';

  const emit = (name: string, data: Record<string, unknown>): void => {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(sseEvent(name, { type: name, sequence_number: seq++, ...data })));
    } catch {
      closed = true;
    }
  };
  const emitDone = (): void => {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    } catch {
      closed = true;
    }
  };

  const responseSnapshot = (status: string) => ({
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status,
    model: modelId,
    output: finishedItems,
    usage: null,
  });

  const closeCurrentMessage = (): void => {
    if (!currentMsg) return;
    emit('response.output_text.done', {
      item_id: currentMsg.itemId,
      output_index: currentMsg.outputIndex,
      content_index: 0,
      text: currentMsg.text,
    });
    emit('response.content_part.done', {
      item_id: currentMsg.itemId,
      output_index: currentMsg.outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: currentMsg.text, annotations: [] },
    });
    const item = {
      type: 'message',
      id: currentMsg.itemId,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: currentMsg.text, annotations: [] }],
    };
    emit('response.output_item.done', { output_index: currentMsg.outputIndex, item });
    finishedItems.push(item);
    outputIndex++;
    currentMsg = null;
  };

  const closeCurrentToolCall = (): void => {
    if (!currentToolCall) return;
    // Empty input (no-arg tools) must serialize as '{}', never '' — Codex
    // echoes the call back next turn and JSON.parse('') would 400 the session.
    const argsStr = currentToolCall.args || '{}';
    if (currentToolCall.freeform) {
      emit('response.custom_tool_call_input.done', {
        item_id: currentToolCall.itemId,
        output_index: currentToolCall.outputIndex,
        input: freeformInput(currentToolCall.args),
      });
      const item = {
        type: 'custom_tool_call',
        id: currentToolCall.itemId,
        call_id: currentToolCall.callId,
        name: currentToolCall.name,
        input: freeformInput(currentToolCall.args),
        status: 'completed',
      };
      emit('response.output_item.done', { output_index: currentToolCall.outputIndex, item });
      finishedItems.push(item);
    } else {
      emit('response.function_call_arguments.done', {
        item_id: currentToolCall.itemId,
        output_index: currentToolCall.outputIndex,
        arguments: argsStr,
      });
      const item = {
        type: 'function_call',
        id: currentToolCall.itemId,
        call_id: currentToolCall.callId,
        name: currentToolCall.name,
        arguments: argsStr,
        status: 'completed',
      };
      emit('response.output_item.done', { output_index: currentToolCall.outputIndex, item });
      finishedItems.push(item);
    }
    outputIndex++;
    currentToolCall = null;
  };

  function freeformInput(args: string): string {
    try {
      const parsed: unknown = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && typeof (parsed as { input?: unknown }).input === 'string') {
        return (parsed as { input: string }).input;
      }
    } catch {
      // raw
    }
    return args;
  }

  const closeCurrentReasoning = (): void => {
    if (!currentReasoning) return;
    emit('response.reasoning_summary_text.done', {
      item_id: currentReasoning.itemId,
      output_index: currentReasoning.outputIndex,
      summary_index: 0,
      text: currentReasoning.text,
    });
    emit('response.reasoning_summary_part.done', {
      item_id: currentReasoning.itemId,
      output_index: currentReasoning.outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: currentReasoning.text },
    });
    const item = {
      type: 'reasoning',
      id: currentReasoning.itemId,
      summary: [{ type: 'summary_text', text: currentReasoning.text }],
    };
    emit('response.output_item.done', { output_index: currentReasoning.outputIndex, item });
    finishedItems.push(item);
    outputIndex++;
    currentReasoning = null;
  };

  const handleEvent = (event: BridgeEvent): boolean => {
    lastEventAt = now();
    let terminal = false;
    switch (event.type) {
      case 'text_delta': {
        if (currentReasoning) closeCurrentReasoning();
        if (options.compaction) {
          compactionText += event.text;
          break;
        }
        if (!currentMsg) {
          const itemId = `msg_${uuid()}`;
          emit('response.output_item.added', {
            output_index: outputIndex,
            item: { type: 'message', id: itemId, status: 'in_progress', role: 'assistant', content: [] },
          });
          emit('response.content_part.added', {
            item_id: itemId,
            output_index: outputIndex,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          });
          currentMsg = { itemId, outputIndex, text: '' };
        }
        currentMsg.text += event.text;
        emit('response.output_text.delta', {
          item_id: currentMsg.itemId,
          output_index: currentMsg.outputIndex,
          content_index: 0,
          delta: event.text,
        });
        break;
      }
      case 'thinking_delta': {
        if (options.hideThinkingSummary) {
          // No signed envelope exists for browser reasoning; suppressed text
          // is simply not replayed (the assistant answer round-trips alone).
          hiddenThinkingText += event.thinking;
          break;
        }
        if (currentMsg) closeCurrentMessage();
        if (!currentReasoning) {
          const itemId = `rs_${uuid()}`;
          emit('response.output_item.added', {
            output_index: outputIndex,
            item: { type: 'reasoning', id: itemId, summary: [] },
          });
          emit('response.reasoning_summary_part.added', {
            item_id: itemId,
            output_index: outputIndex,
            summary_index: 0,
            part: { type: 'summary_text', text: '' },
          });
          currentReasoning = { itemId, outputIndex, text: '' };
        }
        currentReasoning.text += event.thinking;
        emit('response.reasoning_summary_text.delta', {
          item_id: currentReasoning.itemId,
          output_index: currentReasoning.outputIndex,
          summary_index: 0,
          delta: event.thinking,
        });
        break;
      }
      case 'tool_call_start': {
        if (currentMsg) closeCurrentMessage();
        if (currentReasoning) closeCurrentReasoning();
        if (currentToolCall) closeCurrentToolCall();
        const itemId = `fc_${uuid()}`;
        const item = event.freeform
          ? { type: 'custom_tool_call', id: itemId, call_id: event.id, name: event.name, input: '', status: 'in_progress' }
          : { type: 'function_call', id: itemId, call_id: event.id, name: event.name, arguments: '', status: 'in_progress' };
        emit('response.output_item.added', { output_index: outputIndex, item });
        currentToolCall = { itemId, outputIndex, callId: event.id, name: event.name, args: '', freeform: event.freeform };
        break;
      }
      case 'tool_call_delta': {
        if (currentToolCall) {
          currentToolCall.args += event.arguments;
          if (!currentToolCall.freeform) {
            emit('response.function_call_arguments.delta', {
              item_id: currentToolCall.itemId,
              output_index: currentToolCall.outputIndex,
              delta: event.arguments,
            });
          }
        }
        break;
      }
      case 'tool_call_end': {
        closeCurrentToolCall();
        break;
      }
      case 'done': {
        if (currentMsg) closeCurrentMessage();
        if (currentReasoning) closeCurrentReasoning();
        if (currentToolCall) closeCurrentToolCall();
        if (options.compaction) {
          const item = {
            type: 'compaction',
            id: `cmp_${uuid()}`,
            encrypted_content: encodeCompactionSummary(compactionText),
          };
          emit('response.output_item.done', { output_index: outputIndex, item });
          finishedItems.push(item);
          outputIndex++;
        }
        emit('response.completed', {
          response: { ...responseSnapshot('completed'), usage: responsesUsage(event.usage) },
        });
        terminal = true;
        break;
      }
      case 'incomplete': {
        if (currentMsg) closeCurrentMessage();
        if (currentReasoning) closeCurrentReasoning();
        if (currentToolCall) closeCurrentToolCall();
        emit('response.incomplete', {
          response: {
            ...responseSnapshot('incomplete'),
            usage: responsesUsage(undefined),
            incomplete_details: {
              reason: event.reason,
              ...(event.message ? { message: event.message } : {}),
            },
          },
        });
        terminal = true;
        break;
      }
      case 'error': {
        if (currentMsg) closeCurrentMessage();
        if (currentReasoning) closeCurrentReasoning();
        if (currentToolCall) closeCurrentToolCall();
        const error = {
          code: event.code ?? 'bridge_error',
          message: event.message,
          type: event.errorType ?? 'server_error',
        };
        emit('response.failed', {
          response: { ...responseSnapshot('failed'), error, last_error: error },
        });
        terminal = true;
        break;
      }
      case 'heartbeat':
        break;
    }
    return terminal;
  };

  const pump = async (): Promise<void> => {
    const iterator = events[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          if (!terminated) {
            if (currentMsg) closeCurrentMessage();
            if (currentReasoning) closeCurrentReasoning();
            if (currentToolCall) closeCurrentToolCall();
            emit('response.incomplete', {
              response: {
                ...responseSnapshot('incomplete'),
                incomplete_details: { reason: 'adapter_eof' },
              },
            });
            terminated = true;
          }
          break;
        }
        if (handleEvent(next.value)) {
          terminated = true;
          try {
            void iterator.return?.();
          } catch {
            // best-effort
          }
          break;
        }
      }
    } catch (error) {
      if (!terminated) {
        if (currentMsg) closeCurrentMessage();
        if (currentReasoning) closeCurrentReasoning();
        if (currentToolCall) closeCurrentToolCall();
        const message = error instanceof Error ? error.message : String(error);
        const errorPayload = { code: 'bridge_error', message, type: 'server_error' };
        emit('response.failed', {
          response: { ...responseSnapshot('failed'), error: errorPayload, last_error: errorPayload },
        });
        terminated = true;
      }
    }
    emitDone();
    if (beat) clearInterval(beat);
    try {
      controller.close();
    } catch {
      // already closed
    }
    closed = true;
  };

  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      emit('response.created', { response: responseSnapshot('in_progress') });
      beat = setInterval(() => {
        if (closed || terminated) return;
        const silence = now() - lastEventAt;
        if (silence >= stallTimeoutMs) {
          if (currentMsg) closeCurrentMessage();
          if (currentReasoning) closeCurrentReasoning();
          emit('response.incomplete', {
            response: {
              ...responseSnapshot('incomplete'),
              incomplete_details: { reason: 'upstream_stall_timeout' },
            },
          });
          terminated = true;
          emitDone();
          if (beat) clearInterval(beat);
          try {
            controller.close();
          } catch {
            // already closed
          }
          closed = true;
          return;
        }
        // Any received event re-arms Codex's idle timer; unknown types are ignored.
        try {
          controller.enqueue(encoder.encode('event: response.heartbeat\ndata: {"type":"response.heartbeat"}\n\n'));
        } catch {
          closed = true;
        }
      }, heartbeatMs);
      void pump();
    },
    cancel() {
      closed = true;
      if (beat) clearInterval(beat);
    },
  });
}

/** Batch variant: fold events into one JSON response document (stream=false). */
export function buildResponseJSON(
  events: readonly BridgeEvent[],
  modelId: string,
  options: { hideThinkingSummary?: boolean; compaction?: boolean } = {},
): Record<string, unknown> {
  const output: Array<Record<string, unknown>> = [];
  let usage: BridgeUsage | undefined;
  let errorEvent: Extract<BridgeEvent, { type: 'error' }> | undefined;
  let incompleteEvent: Extract<BridgeEvent, { type: 'incomplete' }> | undefined;
  let text = '';
  let thinking = '';
  let compactionText = '';

  const flushText = () => {
    if (!text) return;
    output.push({
      type: 'message',
      id: `msg_${uuid()}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
    text = '';
  };
  const flushThinking = () => {
    if (!thinking || options.hideThinkingSummary) {
      thinking = '';
      return;
    }
    output.push({
      type: 'reasoning',
      id: `rs_${uuid()}`,
      summary: [{ type: 'summary_text', text: thinking }],
    });
    thinking = '';
  };

  for (const event of events) {
    switch (event.type) {
      case 'text_delta':
        if (options.compaction) compactionText += event.text;
        else text += event.text;
        break;
      case 'thinking_delta':
        thinking += event.thinking;
        break;
      case 'done':
        usage = event.usage;
        break;
      case 'error':
        errorEvent = event;
        break;
      case 'incomplete':
        incompleteEvent = event;
        break;
      case 'heartbeat':
        break;
    }
  }
  flushText();
  flushThinking();
  if (options.compaction && !errorEvent && !incompleteEvent) {
    output.push({ type: 'compaction', id: `cmp_${uuid()}`, encrypted_content: encodeCompactionSummary(compactionText) });
  }

  const error = errorEvent
    ? {
        code: errorEvent.code ?? 'bridge_error',
        message: errorEvent.message,
        type: errorEvent.errorType ?? 'server_error',
      }
    : undefined;
  return {
    id: `resp_${uuid()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: errorEvent ? 'failed' : incompleteEvent ? 'incomplete' : 'completed',
    model: modelId,
    output,
    ...(error ? { error, last_error: error } : {}),
    ...(incompleteEvent
      ? { incomplete_details: { reason: incompleteEvent.reason, ...(incompleteEvent.message ? { message: incompleteEvent.message } : {}) } }
      : {}),
    usage: responsesUsage(usage),
  };
}

/** JSON error envelope in the Responses error shape. */
export function formatErrorPayload(
  status: number,
  type: string,
  message: string,
  code?: string,
): Record<string, unknown> {
  return {
    error: {
      code: code ?? (type !== 'server_error' ? type : status === 400 ? 'invalid_request_error' : 'server_error'),
      message,
      type,
    },
  };
}
