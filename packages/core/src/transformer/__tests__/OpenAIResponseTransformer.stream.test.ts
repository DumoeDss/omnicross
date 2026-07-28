/**
 * OpenAIResponseTransformer — codex function-call streaming (PROVIDER-decode SSE)
 *
 * Gate for the `fix-codex-cx2cc-tooluse` change (Task 2).
 *
 * A codex Responses stream carries function calls as:
 *   - `response.output_item.added` (item.type === 'function_call')
 *   - `response.function_call_arguments.delta` (many, token-by-token)
 *   - `response.completed`
 *
 * `convertResponseApiStreamToOpenAI` (reachable here via `transformResponseOut`)
 * must translate those into OpenAI-chat `tool_calls` deltas so step 2
 * (`AnthropicOpenAIToAnthropicStream`) can map them to Anthropic `tool_use`.
 * Before the fix, the function-call events were silently dropped and the client
 * got an empty assistant turn.
 *
 * @module transformer/__tests__/OpenAIResponseTransformer.stream.test
 */

import { describe, expect, it } from 'vitest';

import { OpenAIResponseTransformer } from '../transformers/OpenAIResponseTransformer';
import type { TransformerContext } from '../types';

const mockContext: TransformerContext = {
  providerName: 'codex',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a text/event-stream Response from a list of raw SSE frame strings. */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Drain an SSE Response body into the parsed `data:` JSON events. */
async function drainSseEvents(response: Response): Promise<Array<Record<string, any>>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: Array<Record<string, any>> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }

  for (const line of buffer.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]' || data === '') continue;
    events.push(JSON.parse(data));
  }
  return events;
}

describe('OpenAIResponseTransformer — codex function-call streaming (Task 2)', () => {
  const transformer = new OpenAIResponseTransformer();

  it('maps a codex function_call stream to OpenAI-chat tool_calls deltas', async () => {
    // Real codex shape: output_item.added (function_call) → argument deltas →
    // response.completed. The argument fragments concatenate to a complete JSON
    // object: {"pattern":"**/*.md"}
    const respFrames = [
      'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","status":"in_progress","arguments":"","call_id":"call_abc","name":"Glob"},"output_index":1,"sequence_number":4}\n\n',
      'data: {"type":"response.function_call_arguments.delta","delta":"{\\"","item_id":"fc_1","output_index":1,"sequence_number":5}\n\n',
      'data: {"type":"response.function_call_arguments.delta","delta":"pattern\\":\\"**/*.md\\"}","item_id":"fc_1","output_index":1,"sequence_number":6}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5-codex","usage":{"input_tokens":10,"output_tokens":3}}}\n\n',
      'data: [DONE]\n\n',
    ];

    const out = await transformer.transformResponseOut(sseResponse(respFrames), mockContext);
    expect(out.headers.get('Content-Type')).toContain('text/event-stream');

    const events = await drainSseEvents(out);

    // Every emitted chunk is an OpenAI-chat chat.completion.chunk.
    for (const e of events) {
      expect(e.object).toBe('chat.completion.chunk');
    }

    // The function_call's opening delta carries id + name + empty arguments.
    const openCalls = events
      .flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? [])
      .filter((tc) => tc.id !== undefined);
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0]).toEqual({
      index: 1,
      id: 'call_abc',
      type: 'function',
      function: { name: 'Glob', arguments: '' },
    });

    // The argument fragments concatenate back to the original JSON.
    const argsText = events
      .flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? [])
      .filter((tc) => tc.function?.arguments !== undefined && tc.id === undefined)
      .map((tc) => tc.function.arguments)
      .join('');
    expect(argsText).toBe('{"pattern":"**/*.md"}');

    // The terminal chunk finishes with `tool_calls` (NOT `stop`).
    const finalChunk = events.find((e) => e.choices?.[0]?.finish_reason !== null);
    expect(finalChunk).toBeDefined();
    expect(finalChunk!.choices[0].finish_reason).toBe('tool_calls');
  });

  it('regression: a pure-text turn still finishes with finish_reason "stop"', async () => {
    const respFrames = [
      'data: {"type":"response.output_text.delta","delta":"Hi","response":{"model":"gpt-5-codex"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"!","response":{"model":"gpt-5-codex"}}\n\n',
      'data: {"type":"response.completed","response":{"model":"gpt-5-codex","usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
      'data: [DONE]\n\n',
    ];

    const out = await transformer.transformResponseOut(sseResponse(respFrames), mockContext);
    const events = await drainSseEvents(out);

    // No tool_calls delta in a text-only turn.
    const anyToolCall = events.some((e) => e.choices?.[0]?.delta?.tool_calls);
    expect(anyToolCall).toBe(false);

    const finalChunk = events.find((e) => e.choices?.[0]?.finish_reason !== null);
    expect(finalChunk).toBeDefined();
    expect(finalChunk!.choices[0].finish_reason).toBe('stop');
  });
});
