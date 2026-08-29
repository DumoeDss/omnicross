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
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
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
