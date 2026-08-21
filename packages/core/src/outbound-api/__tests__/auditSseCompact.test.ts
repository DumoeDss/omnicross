import { describe, expect, it } from 'vitest';

import { compactSseBody, MERGED_FRAMES_FIELD } from '../auditSseCompact';

/** Build an SSE stream from `event`/payload pairs. */
const sse = (frames: Array<[string, unknown]>): string =>
  frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}`).join('\n\n') + '\n\n';

const textDelta = (text: string): [string, unknown] => [
  'content_block_delta',
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
];

const dataPayloads = (out: string): Array<Record<string, unknown>> =>
  out
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);

describe('compactSseBody', () => {
  it('merges a run of Anthropic text deltas into one frame', () => {
    const out = compactSseBody(
      sse([
        ['message_start', { type: 'message_start', message: { id: 'm1' } }],
        textDelta('Hel'),
        textDelta('lo '),
        textDelta('world'),
        ['message_stop', { type: 'message_stop' }],
      ]),
    );
    const payloads = dataPayloads(out);
    expect(payloads).toHaveLength(3);
    expect(payloads[1]).toMatchObject({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Hello world' },
      [MERGED_FRAMES_FIELD]: 3,
    });
    expect(out.length).toBeLessThan(sse([textDelta('Hel'), textDelta('lo '), textDelta('world')]).length);
  });

  it('NEVER swallows a failure frame', () => {
    // The "at capacity" overload shape: HTTP 200 with a response.failed frame.
    const out = compactSseBody(
      sse([
        ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'i1', delta: 'a' }],
        ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'i1', delta: 'b' }],
        ['response.failed', { type: 'response.failed', response: { error: { message: 'server is at capacity' } } }],
      ]),
    );
    expect(out).toContain('server is at capacity');
    expect(out).toContain('response.failed');
    const payloads = dataPayloads(out);
    expect(payloads[0]).toMatchObject({ delta: 'ab', [MERGED_FRAMES_FIELD]: 2 });
  });

  it('keeps usage and error frames verbatim', () => {
    const out = compactSseBody(
      sse([
        textDelta('x'),
        textDelta('y'),
        ['message_delta', { type: 'message_delta', usage: { output_tokens: 42 } }],
        ['error', { type: 'error', error: { type: 'overloaded_error' } }],
      ]),
    );
    expect(out).toContain('"output_tokens":42');
    expect(out).toContain('overloaded_error');
  });

  it('does not merge across different content blocks', () => {
    const block = (index: number, text: string): [string, unknown] => [
      'content_block_delta',
      { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    ];
    const out = compactSseBody(sse([block(0, 'a'), block(0, 'b'), block(1, 'c'), block(1, 'd')]));
    const payloads = dataPayloads(out);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ index: 0, delta: { text: 'ab' } });
    expect(payloads[1]).toMatchObject({ index: 1, delta: { text: 'cd' } });
  });

  it('merges OpenAI chat content but leaves a tool-call or closing frame alone', () => {
    const chat = (delta: unknown, finish: string | null = null): [string, unknown] => [
      'chunk',
      { choices: [{ index: 0, delta, finish_reason: finish }] },
    ];
    const out = compactSseBody(
      sse([
        chat({ content: 'a' }),
        chat({ content: 'b' }),
        chat({ tool_calls: [{ index: 0, function: { arguments: '{' } }] }),
        chat({ content: 'z' }, 'stop'),
      ]),
    );
    const payloads = dataPayloads(out);
    expect(payloads).toHaveLength(3);
    expect(payloads[0]).toMatchObject({ choices: [{ delta: { content: 'ab' } }] });
    expect(JSON.stringify(payloads[1])).toContain('tool_calls');
    expect(payloads[2]).toMatchObject({ choices: [{ finish_reason: 'stop' }] });
  });

  it('returns non-SSE, Gemini, and already-minimal payloads unchanged', () => {
    const json = '{"error":{"message":"bad request"}}';
    expect(compactSseBody(json)).toBe(json);
    expect(compactSseBody('')).toBe('');

    // Gemini streams whole candidate objects; merging them would drop finishReason.
    const gemini = sse([
      ['chunk', { candidates: [{ content: { parts: [{ text: 'a' }] } }] }],
      ['chunk', { candidates: [{ content: { parts: [{ text: 'b' }] }, finishReason: 'STOP' }] }],
    ]);
    expect(compactSseBody(gemini)).toBe(gemini);

    // A single delta is not a "run" — nothing to merge, so it stays byte-identical.
    const single = sse([textDelta('only')]);
    expect(compactSseBody(single)).toBe(single);
  });

  it('leaves an unparseable frame in place instead of dropping it', () => {
    const stream = 'event: content_block_delta\ndata: {not json\n\ndata: [DONE]\n\n';
    expect(compactSseBody(stream)).toBe(stream);
  });
});
