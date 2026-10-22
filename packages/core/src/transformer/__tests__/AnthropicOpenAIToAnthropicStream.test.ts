/**
 * Tests for the translation-path synthetic SSE converter
 * (`claude-api-protocol-fidelity`, R6 / capability anthropic-synthetic-stream):
 * message_start usage backfill, official in-band error shape, the complete
 * stop_reason map with the content_filter counter, and the lazy synthetic-ping
 * heartbeat (fake timers: silence fires, flow never does, end/error/cancel
 * leak no timer). Also pins the aggregator's tolerance of ping frames.
 *
 * @module transformer/__tests__/AnthropicOpenAIToAnthropicStream.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { aggregateAnthropicSseToJsonBody } from '../../provider-proxy/ingress/providerProxyShared';
import {
  DEFAULT_ANTHROPIC_PING_HEARTBEAT_MS,
  __resetStopReasonContentFilterCountForTests,
  convertOpenAIStreamToAnthropic,
  getAnthropicPingHeartbeatMs,
  setAnthropicPingHeartbeatMs,
  stopReasonContentFilterCount,
} from '../transformers/AnthropicOpenAIToAnthropicStream';
import { convertAnthropicStreamToOpenAI } from '../transformers/AnthropicAnthropicToOpenAIStream';
import { transformAnthropicRequestToUnified } from '../transformers/AnthropicConversion';
import { buildRequestBody as buildGeminiRequestBody } from '../transformers/utils/gemini.util';
import { transformResponseOut as decodeGeminiResponse } from '../transformers/utils/gemini.stream';

const encoder = new TextEncoder();

/** A controllable upstream SSE source (enqueue + close by hand). */
function makeSource() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    send(text: string): void {
      controller.enqueue(encoder.encode(text));
    },
    close(): void {
      controller.close();
    },
    error(e?: unknown): void {
      controller.error(e);
    },
  };
}

/** Drain a converted stream fully to text (the stream must eventually close). */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

/** Parse every SSE `data:` payload out of a converted stream text. */
function dataEvents(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      events.push(JSON.parse(payload) as Record<string, unknown>);
    } catch {
      /* ignore */
    }
  }
  return events;
}

function openaiChunk(over: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({
    id: 'c1',
    object: 'chat.completion.chunk',
    model: 'gpt-test',
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }],
    ...over,
  })}\n\n`;
}

describe('message_start usage backfill (R6)', () => {
  it('first chunk carries usage → message_start has the real net input_tokens', async () => {
    const src = makeSource();
    src.send(
      openaiChunk({
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
        usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 20 } },
      }),
    );
    src.send(openaiChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    src.close();
    const text = await drain(convertOpenAIStreamToAnthropic(src.stream));
    const start = dataEvents(text).find((e) => e['type'] === 'message_start') as {
      message: { usage: Record<string, number> };
    };
    expect(start.message.usage['input_tokens']).toBe(80); // 100 − 20 cached
    expect(start.message.usage['output_tokens']).toBe(5);
  });

  it('usage only in the terminal chunk → message_start stays 0, message_delta accumulates (regression)', async () => {
    const src = makeSource();
    src.send(openaiChunk());
    src.send(
      `data: ${JSON.stringify({
        id: 'c1',
        model: 'gpt-test',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 42, completion_tokens: 7 },
      })}\n\n`,
    );
    src.send('data: [DONE]\n\n');
    src.close();
    const text = await drain(convertOpenAIStreamToAnthropic(src.stream));
    const events = dataEvents(text);
    const start = events.find((e) => e['type'] === 'message_start') as {
      message: { usage: { input_tokens: number } };
    };
    const delta = events.find((e) => e['type'] === 'message_delta') as {
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(start.message.usage.input_tokens).toBe(0);
    expect(delta.usage.input_tokens).toBe(42);
    expect(delta.usage.output_tokens).toBe(7);
  });
});

describe('in-band error event shape (R6)', () => {
  it('emits the official shape with the upstream text preserved verbatim', async () => {
    const src = makeSource();
    src.send(`data: ${JSON.stringify({ error: { message: 'boom', code: 500 } })}\n\n`);
    src.close();
    const text = await drain(convertOpenAIStreamToAnthropic(src.stream));
    expect(text).toContain('event: error');
    const err = dataEvents(text).find((e) => e['type'] === 'error') as {
      error: { type: string; message: string };
    };
    expect(err.error.type).toBe('overloaded_error'); // status 500 → overload sniff
    expect(err.error.message).toBe(JSON.stringify({ message: 'boom', code: 500 }));
    // The OLD nested shape is gone.
    expect(text).not.toContain('"stop_sequence":null,"usage"');
  });

  it('a plain client-error body sniffs to api_error', async () => {
    const src = makeSource();
    src.send(`data: ${JSON.stringify({ error: { message: 'invalid request' } })}\n\n`);
    src.close();
    const text = await drain(convertOpenAIStreamToAnthropic(src.stream));
    const err = dataEvents(text).find((e) => e['type'] === 'error') as { error: { type: string } };
    expect(err.error.type).toBe('api_error');
  });

  it("overload wording ('at capacity' / 'server_error') sniffs to overloaded_error", async () => {
    for (const message of ['service is at capacity', 'server_error: upstream']) {
      const src = makeSource();
      src.send(`data: ${JSON.stringify({ error: { message } })}\n\n`);
      src.close();
      const text = await drain(convertOpenAIStreamToAnthropic(src.stream));
      const err = dataEvents(text).find((e) => e['type'] === 'error') as { error: { type: string } };
      expect(err.error.type).toBe('overloaded_error');
    }
  });

  it('a codex response.failed event surfaces as the official error event (R8)', async () => {
    const src = makeSource();
    src.send(
      `data: ${JSON.stringify({
        type: 'response.failed',
        response: { error: { code: 'server_is_overloaded', message: 'The server is overloaded' } },
      })}\n\n`,
    );
    src.close();
    const text = await drain(convertOpenAIStreamToAnthropic(src.stream));
    const err = dataEvents(text).find((e) => e['type'] === 'error') as {
      error: { type: string; message: string };
    };
    expect(err).toBeDefined();
    expect(err.error.type).toBe('overloaded_error');
    expect(err.error.message).toContain('server_is_overloaded');
  });
});

describe('stop_reason mapping (R6)', () => {
  async function stopReasonFor(finishReason: string): Promise<string> {
    const src = makeSource();
    src.send(
      `data: ${JSON.stringify({
        id: 'c1',
        model: 'gpt-test',
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      })}\n\n`,
    );
    src.close();
    const text = await drain(convertOpenAIStreamToAnthropic(src.stream));
    const delta = dataEvents(text).find((e) => e['type'] === 'message_delta') as {
      delta: { stop_reason: string };
    };
    return delta.delta.stop_reason;
  }

  it('maps content_filter → refusal and bumps the observable counter', async () => {
    __resetStopReasonContentFilterCountForTests();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = stopReasonContentFilterCount;
    try {
      await expect(stopReasonFor('content_filter')).resolves.toBe('refusal');
      expect(stopReasonContentFilterCount).toBe(before + 1);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('pins stop/length/tool_calls, the placeholders, and the unknown fallback', async () => {
    await expect(stopReasonFor('stop')).resolves.toBe('end_turn');
    await expect(stopReasonFor('length')).resolves.toBe('max_tokens');
    await expect(stopReasonFor('tool_calls')).resolves.toBe('tool_use');
    await expect(stopReasonFor('refusal')).resolves.toBe('refusal');
    await expect(stopReasonFor('pause_turn')).resolves.toBe('pause_turn');
    await expect(stopReasonFor('something_new')).resolves.toBe('end_turn');
  });
});

describe('synthetic ping heartbeat (R6, fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setAnthropicPingHeartbeatMs(20_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    setAnthropicPingHeartbeatMs(DEFAULT_ANTHROPIC_PING_HEARTBEAT_MS);
  });

  it('defaults to 20000; setter accepts hot changes and ≤0 (disabled)', () => {
    expect(DEFAULT_ANTHROPIC_PING_HEARTBEAT_MS).toBe(20_000);
    expect(getAnthropicPingHeartbeatMs()).toBe(20_000);
    setAnthropicPingHeartbeatMs(5_000);
    expect(getAnthropicPingHeartbeatMs()).toBe(5_000);
    setAnthropicPingHeartbeatMs(-1);
    expect(getAnthropicPingHeartbeatMs()).toBe(-1);
    setAnthropicPingHeartbeatMs(undefined);
    expect(getAnthropicPingHeartbeatMs()).toBe(20_000);
  });

  it('silence past the interval emits pings, repeating while silent', async () => {
    const src = makeSource();
    const out = convertOpenAIStreamToAnthropic(src.stream);
    src.send(openaiChunk());
    await vi.advanceTimersByTimeAsync(0); // let the first conversion burst run
    // Two consecutive silent intervals → two ping frames.
    await vi.advanceTimersByTimeAsync(20_001);
    await vi.advanceTimersByTimeAsync(20_001);
    src.close();
    const text = await drain(out);
    expect(text).toContain('event: ping');
    expect(text).toContain('{"type":"ping"}');
    expect((text.match(/event: ping/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('a flowing stream (chunks inside the interval) never sees a synthesized ping', async () => {
    const src = makeSource();
    const out = convertOpenAIStreamToAnthropic(src.stream);
    src.send(openaiChunk());
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(5_000); // < 20000 interval
      src.send(openaiChunk());
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(5_000);
    src.close();
    const text = await drain(out);
    expect(text).toContain('event: message_start');
    expect(text).not.toContain('event: ping');
  });

  it('heartbeat ≤0 (disabled) → silence emits nothing', async () => {
    setAnthropicPingHeartbeatMs(0);
    const src = makeSource();
    const out = convertOpenAIStreamToAnthropic(src.stream);
    src.send(openaiChunk());
    await vi.advanceTimersByTimeAsync(120_000);
    src.close();
    const text = await drain(out);
    expect(text).not.toContain('event: ping');
  });

  it('normal end clears the timer (no leak, no post-end ping)', async () => {
    const src = makeSource();
    src.send(openaiChunk());
    src.close();
    const text = await drain(convertOpenAIStreamToAnthropic(src.stream));
    expect(text).not.toContain('event: ping');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('upstream error clears the timer (no leak)', async () => {
    const src = makeSource();
    src.send(openaiChunk());
    src.error(new Error('upstream died'));
    await expect(drain(convertOpenAIStreamToAnthropic(src.stream))).rejects.toThrow('upstream died');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('client cancel clears the timer (no leak, no further ping)', async () => {
    const src = makeSource();
    src.send(openaiChunk());
    const out = convertOpenAIStreamToAnthropic(src.stream);
    const reader = out.getReader();
    await vi.advanceTimersByTimeAsync(0);
    await reader.read(); // consume the first burst; loop now awaits upstream
    await reader.cancel();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('aggregator tolerance of ping frames', () => {
  it('aggregateAnthropicSseToJsonBody ignores event: ping frames', async () => {
    const sse = [
      'event: ping\ndata: {"type":"ping"}\n\n',
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { id: 'm1', model: 'x', usage: { input_tokens: 3 } },
      })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' },
      })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 },
      })}\n\n`,
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    const fakeResponse = { text: async () => sse } as unknown as Response;
    const body = JSON.parse(await aggregateAnthropicSseToJsonBody(fakeResponse)) as {
      type: string;
      content: Array<{ type: string; text: string }>;
      usage: Record<string, number>;
      stop_reason: string;
    };
    expect(body.type).toBe('message');
    expect(body.content[0].text).toBe('hi');
    expect(body.usage['input_tokens']).toBe(3);
    expect(body.usage['output_tokens']).toBe(2);
    expect(body.stop_reason).toBe('end_turn');
  });
});

describe('reasoning and tool stream semantics', () => {
  it('emits unsigned native reasoning before text and complete parallel tool blocks, retaining trailing usage', async () => {
    const src = makeSource();
    const send = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
      src.send(openaiChunk({ choices: [{ index: 0, delta, finish_reason }] }));
    send({ reasoning_content: '先想' });
    send({ reasoning_content: '清楚', content: 'Checking.' });
    send({ tool_calls: [
      { index: 0, id: 'a', function: { name: 'lookup', arguments: '{"q":' } },
      { index: 1, id: 'b', function: { name: 'lookup', arguments: '{"q":' } },
    ] });
    send({ tool_calls: [
      { index: 1, function: { arguments: '"B"}' } },
      { index: 0, function: { arguments: '"A"}' } },
    ] }, 'tool_calls');
    src.send(openaiChunk({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 4 } } }));
    src.close();
    const text = await drain(convertOpenAIStreamToAnthropic(src.stream));
    const events = dataEvents(text);
    const open = new Set<unknown>();
    for (const event of events) {
      if (event.type === 'content_block_start') {
        expect(open.size).toBe(0);
        open.add(event.index);
      } else if (event.type === 'content_block_delta') {
        expect(open.has(event.index)).toBe(true);
      } else if (event.type === 'content_block_stop') {
        expect(open.delete(event.index)).toBe(true);
      }
    }
    expect(open.size).toBe(0);
    const result = JSON.parse(await aggregateAnthropicSseToJsonBody(new Response(text)));
    expect(result.content).toEqual([
      { type: 'thinking', thinking: '先想清楚' },
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'a', name: 'lookup', input: { q: 'A' } },
      { type: 'tool_use', id: 'b', name: 'lookup', input: { q: 'B' } },
    ]);
    expect(result.stop_reason).toBe('tool_use');
    expect(result.usage).toMatchObject({ input_tokens: 8, output_tokens: 7, cache_read_input_tokens: 4 });
  });

  it('round-trips separate thinking blocks and split signatures, including a thinking-only ending', async () => {
    const src = makeSource();
    const send = (event: Record<string, unknown>) => src.send(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'message_start', message: { id: 'm', model: 'claude', usage: { input_tokens: 9, cache_read_input_tokens: 2 } } });
    for (const [index, thinking, signature] of [[0, 'first', 'sig1'], [1, 'second', 'sig2']] as const) {
      send({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
      send({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } });
      send({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: signature.slice(0, 2) } });
      send({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: signature.slice(2) } });
      send({ type: 'content_block_stop', index });
    }
    send({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 5 } });
    send({ type: 'message_stop' });
    src.close();
    const text = await drain(convertOpenAIStreamToAnthropic(convertAnthropicStreamToOpenAI(src.stream)));
    const result = JSON.parse(await aggregateAnthropicSseToJsonBody(new Response(text)));
    expect(result.content).toEqual([
      { type: 'thinking', thinking: 'first', signature: 'sig1' },
      { type: 'thinking', thinking: 'second', signature: 'sig2' },
    ]);
    expect(result.stop_reason).toBe('max_tokens');
    expect(result.usage).toMatchObject({ input_tokens: 9, output_tokens: 5, cache_read_input_tokens: 2 });
  });

  it('decodes split UTF-8, CRLF, multiline data, and an unterminated final frame', async () => {
    const wire = 'data: {"model":"m","choices":[\r\ndata: {"delta":{"reasoning_content":"思考"},"finish_reason":"stop"}]}\r\n\r\n';
    const bytes = encoder.encode(wire);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const text = await drain(convertOpenAIStreamToAnthropic(source));
    const result = JSON.parse(await aggregateAnthropicSseToJsonBody(new Response(text)));
    expect(result.content).toEqual([{ type: 'thinking', thinking: '思考' }]);
    const final = makeSource();
    final.send('data: {"choices":[{"delta":{"content":"final"},"finish_reason":"stop"}]}');
    final.close();
    expect(await drain(convertOpenAIStreamToAnthropic(final.stream))).toContain('"text":"final"');
  });

  it('surfaces Anthropic errors without a fabricated finish or DONE success marker', async () => {
    const src = makeSource();
    src.send('data: {"type":"error","error":{"type":"overloaded_error","message":"capacity"}}\n\n');
    src.close();
    const text = await drain(convertAnthropicStreamToOpenAI(src.stream));
    expect(dataEvents(text)).toEqual([{ error: { type: 'overloaded_error', message: 'capacity' } }]);
    expect(text).not.toContain('[DONE]');
    const chat = makeSource();
    chat.send('data: {"error":{"message":"capacity"}}\n\n');
    chat.close();
    const converted = await drain(convertOpenAIStreamToAnthropic(chat.stream));
    expect(converted).toContain('event: error');
    expect(converted).not.toContain('event: message_stop');
  });

  it('cancels the Anthropic upstream when the Chat client disconnects', async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"message_start","message":{"model":"m"}}\n\n'));
      },
      cancel,
    });
    const reader = convertAnthropicStreamToOpenAI(source).getReader();
    await reader.read();
    await reader.cancel('client disconnected');
    expect(cancel).toHaveBeenCalledWith('client disconnected');
  });
});

describe('Anthropic native stream boundaries', () => {
  it('preserves executed search sources and citations without client tool calls', async () => {
    const src = makeSource();
    for (const event of [
      { type: 'message_start', message: { model: 'claude' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 's', name: 'web_search' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"weather"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: {
        type: 'web_search_tool_result', tool_use_id: 's',
        content: [{ title: 'Weather', url: 'https://example.com', encrypted_content: 'opaque' }],
      } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: 'Sunny.' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { title: 'Weather', url: 'https://example.com' } } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]) src.send(`data: ${JSON.stringify(event)}\n\n`);
    src.close();
    const text = await drain(convertAnthropicStreamToOpenAI(src.stream));
    expect(text).toContain('[Weather](https://example.com)');
    expect(text).toContain('Sunny.');
    expect(text).not.toContain('tool_calls');
    expect(text).not.toContain('opaque');
  });

  it('returns valid empty tool input when Anthropic completes a tool block without deltas', async () => {
    const src = makeSource();
    for (const event of [
      { type: 'message_start', message: { model: 'claude' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'ping', input: {} } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ]) src.send(`data: ${JSON.stringify(event)}\n\n`);
    src.close();
    const text = await drain(convertOpenAIStreamToAnthropic(convertAnthropicStreamToOpenAI(src.stream)));
    const response = JSON.parse(await aggregateAnthropicSseToJsonBody(new Response(text)));
    expect(response.content).toEqual([{ type: 'tool_use', id: 'a', name: 'ping', input: {} }]);
  });
});

describe('truncated streams', () => {
  it('does not manufacture successful completion for an unfinished Chat response', async () => {
    const src = makeSource();
    src.send(openaiChunk({ choices: [{ delta: { reasoning_content: 'unfinished' }, finish_reason: null }] }));
    src.close();
    await expect(drain(convertOpenAIStreamToAnthropic(src.stream))).rejects.toThrow('without finish_reason');
  });

  it('does not manufacture DONE for an Anthropic response missing message_stop', async () => {
    const src = makeSource();
    src.send('data: {"type":"message_start","message":{"model":"claude"}}\n\n');
    src.send('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
    src.close();
    await expect(drain(convertAnthropicStreamToOpenAI(src.stream))).rejects.toThrow('without message_stop');
  });
});

describe('streamed foreign signature gateway extensions', () => {
  it('replays late Google metadata without buffering the stream or creating Anthropic signatures', async () => {
    const parts = [
      { text: 'Compare cities.', thought: true },
      { functionCall: { id: 'a', name: 'weather', args: { city: 'A' } }, thoughtSignature: 'google-tool-a' },
      { functionCall: { id: 'b', name: 'weather', args: { city: 'B' } }, thoughtSignature: 'google-tool-b' },
      { text: '', thought: true, thoughtSignature: 'late-google-thought' },
    ];
    const src = makeSource();
    const unified = await decodeGeminiResponse(new Response(src.stream, {
      headers: { 'content-type': 'text/event-stream' },
    }), 'google');
    const reader = convertOpenAIStreamToAnthropic(unified.body!).getReader();
    src.send(`data: ${JSON.stringify({ candidates: [{ content: { parts: [parts[0]] } }] })}\n\n`);
    let text = '';
    const decoder = new TextDecoder();
    while (!text.includes('thinking_delta')) {
      const { value } = await reader.read();
      text += decoder.decode(value);
    }
    for (const part of parts.slice(1)) {
      src.send(`data: ${JSON.stringify({ candidates: [{ content: { parts: [part] } }] })}\n\n`);
    }
    src.send('data: {"candidates":[{"finishReason":"STOP"}]}\n\n');
    src.close();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).not.toContain('signature_delta');
    const response = JSON.parse(await aggregateAnthropicSseToJsonBody(new Response(text)));
    const next = transformAnthropicRequestToUnified({
      model: 'gemini-3.1-pro-preview',
      messages: [
        { role: 'assistant', content: response.content },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'sunny' },
          { type: 'tool_result', tool_use_id: 'b', content: 'rainy' },
        ] },
      ],
    });
    expect(buildGeminiRequestBody(next).contents[0]).toEqual({ role: 'model', parts });
  });
});

describe('validated SSE wire boundaries', () => {
  it('rejects non-string tool argument deltas instead of emitting coerced tool input', async () => {
    const src = makeSource();
    src.send(openaiChunk({ choices: [{
      delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'weather', arguments: { city: 'A' } } }] },
      finish_reason: 'tool_calls',
    }] }));
    src.close();
    await expect(drain(convertOpenAIStreamToAnthropic(src.stream))).rejects.toThrow('tool_call.function.arguments');
  });

  it('accepts nullable Chat usage details and content on a finished response', async () => {
    const src = makeSource();
    src.send(openaiChunk({
      choices: [{ delta: { content: null, reasoning_content: 'Done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, prompt_tokens_details: null },
    }));
    src.close();
    const text = await drain(convertOpenAIStreamToAnthropic(src.stream));
    const response = JSON.parse(await aggregateAnthropicSseToJsonBody(new Response(text)));
    expect(response.content).toEqual([{ type: 'thinking', thinking: 'Done.' }]);
    expect(response.usage).toMatchObject({ input_tokens: 2, output_tokens: 1 });
  });
});
