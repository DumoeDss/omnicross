import { describe, expect, it } from 'vitest';

import { aggregateAnthropicSseToJsonBody } from '../providerProxyShared';

/** Build a `Response` whose body is the given SSE text. */
function sseResponse(events: string, status = 200): Response {
  return new Response(events, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Emit one Anthropic SSE event block (`event: t\ndata: {...}\n\n`). */
function ev(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

describe('aggregateAnthropicSseToJsonBody', () => {
  it('collapses a text + tool_use stream into one buffered message', async () => {
    const sse = [
      ev('message_start', {
        message: { id: 'msg_1', model: 'claude-sonnet-5', usage: { input_tokens: 5 } },
      }),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello ' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'world' } }),
      ev('content_block_stop', { index: 0 }),
      ev('content_block_start', {
        index: 1,
        content_block: { type: 'tool_use', id: 'call_abc', name: 'get_weather', input: {} },
      }),
      ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":"' } }),
      ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: 'Tokyo"}' } }),
      ev('content_block_stop', { index: 1 }),
      ev('message_delta', {
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { input_tokens: 5, output_tokens: 18 },
      }),
      ev('message_stop', {}),
    ].join('');

    const json = await aggregateAnthropicSseToJsonBody(sseResponse(sse));
    const msg = JSON.parse(json);

    expect(msg).toMatchObject({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      stop_reason: 'tool_use',
      stop_sequence: null,
    });
    expect(msg.content).toEqual([
      { type: 'text', text: 'Hello world' },
      { type: 'tool_use', id: 'call_abc', name: 'get_weather', input: { city: 'Tokyo' } },
    ]);
    expect(msg.usage).toMatchObject({ input_tokens: 5, output_tokens: 18 });
  });

  it('rewriteModel overrides the message model (passthrough D4)', async () => {
    const sse = ev('message_start', { message: { id: 'm', model: 'gpt-5.6-sol' } }) +
      ev('message_delta', { delta: { stop_reason: 'end_turn' } }) +
      ev('message_stop', {});
    const msg = JSON.parse(await aggregateAnthropicSseToJsonBody(sseResponse(sse), 'claude-sonnet-5'));
    expect(msg.model).toBe('claude-sonnet-5');
  });

  it('skips malformed data lines without throwing', async () => {
    const sse =
      ev('message_start', { message: { id: 'm', model: 'x' } }) +
      'data: not-json\n\n' +
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }) +
      ev('message_stop', {});
    const msg = JSON.parse(await aggregateAnthropicSseToJsonBody(sseResponse(sse)));
    expect(msg.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('preserves block order by index regardless of arrival', async () => {
    // index 1 starts before index 0 (codex/parallel emit can interleave)
    const sse = [
      ev('message_start', { message: { id: 'm', model: 'x' } }),
      ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'A' } }),
      ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'B' } }),
      ev('message_stop', {}),
    ].join('');
    const msg = JSON.parse(await aggregateAnthropicSseToJsonBody(sseResponse(sse)));
    expect(msg.content.map((c: { text: string }) => c.text)).toEqual(['A', 'B']);
  });
});
