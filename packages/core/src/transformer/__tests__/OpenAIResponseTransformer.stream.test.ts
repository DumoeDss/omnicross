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

describe('OpenAIResponseTransformer — OpenAI-chat tool_calls → Responses function_call (responses endpoint)', () => {
  const transformer = new OpenAIResponseTransformer();

  it('maps an OpenAI-chat tool_call stream to codex function_call events', async () => {
    // An OpenAI-chat upstream (e.g. a BYO provider behind /v1/responses) streams
    // tool_calls; transformResponseIn must emit codex-style function_call events
    // so a Responses client (codex CLI) receives the tool call.
    const openaiFrames = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"glm-5.2","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_xyz","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"glm-5.2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Tokyo\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"glm-5.2","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":8,"completion_tokens":5,"total_tokens":13}}\n\n',
      'data: [DONE]\n\n',
    ];

    const out = await transformer.transformResponseIn(sseResponse(openaiFrames), mockContext);
    expect(out.headers.get('Content-Type')).toContain('text/event-stream');
    const events = await drainSseEvents(out);

    // output_item.added opens a function_call with an fc_-prefixed item id and
    // the call_id as the call handle.
    const added = events.find((e) => e.type === 'response.output_item.added');
    expect(added).toBeDefined();
    expect(added.item.type).toBe('function_call');
    expect(added.item.id.startsWith('fc_')).toBe(true);
    expect(added.item.call_id).toBe('call_xyz');
    expect(added.item.name).toBe('get_weather');

    // argument fragments stream through function_call_arguments.delta.
    const argDeltas = events.filter((e) => e.type === 'response.function_call_arguments.delta');
    const assembled = argDeltas.map((e) => e.delta).join('');
    expect(assembled).toBe('{"city":"Tokyo"}');

    // response.completed carries the function_call in its output (not just text).
    const completed = events.find((e) => e.type === 'response.completed');
    expect(completed).toBeDefined();
    const fc = (completed.response.output ?? []).find((o: Record<string, unknown>) => o.type === 'function_call');
    expect(fc).toBeDefined();
    expect(fc.call_id).toBe('call_xyz');
    expect(fc.arguments).toBe('{"city":"Tokyo"}');
  });

  it('wraps a text reply in output_item.added/done so codex renders it', async () => {
    // Regression: a plain-text assistant reply MUST be wrapped in an
    // output_item.added -> output_text.delta -> output_item.done lifecycle.
    // codex builds its message item from those item events; without them the
    // text deltas arrive (token_count increments) but `last_agent_message`
    // stays null and nothing renders.
    const openaiFrames = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"glm-5.2","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"glm-5.2","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"glm-5.2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\n',
      'data: [DONE]\n\n',
    ];

    const out = await transformer.transformResponseIn(sseResponse(openaiFrames), mockContext);
    const events = await drainSseEvents(out);

    // output_item.added opens the assistant message item at index 0 BEFORE text.
    const added = events.find((e) => e.type === 'response.output_item.added');
    expect(added).toBeDefined();
    expect(added!.output_index).toBe(0);
    expect(added!.item.type).toBe('message');
    expect(added!.item.role).toBe('assistant');

    const addedIdx = events.indexOf(added!);
    const firstDeltaIdx = events.findIndex((e) => e.type === 'response.output_text.delta');
    expect(firstDeltaIdx).toBeGreaterThan(addedIdx);

    // Text deltas assemble the full content and carry output_index/content_index.
    const deltas = events.filter((e) => e.type === 'response.output_text.delta');
    expect(deltas.map((e) => e.delta).join('')).toBe('Hello!');
    for (const d of deltas) {
      expect(d.output_index).toBe(0);
      expect(d.content_index).toBe(0);
    }

    // output_item.done closes the message at index 0 with the final content.
    const done = events.find(
      (e) => e.type === 'response.output_item.done' && e.item?.type === 'message',
    );
    expect(done).toBeDefined();
    expect(done!.output_index).toBe(0);
    expect(done!.item.content[0].text).toBe('Hello!');

    // response.completed still carries the assembled message in its output.
    const completed = events.find((e) => e.type === 'response.completed');
    const msg = (completed!.response.output ?? []).find(
      (o: Record<string, unknown>) => o.type === 'message',
    );
    expect(msg).toBeDefined();
    expect((msg as { content: Array<{ text: string }> }).content[0].text).toBe('Hello!');
  });
});
