/**
 * SSE encoder tests: event framing, terminal guarantees, compaction items.
 *
 * @module @omnicross/chatgpt-web/bridge/__tests__/sse.test
 */

import { describe, expect, it } from 'vitest';

import { buildResponseJSON, bridgeToResponsesSSE } from '../bridge/sse';
import { decodeCompactionSummary } from '../bridge/compaction';
import type { BridgeEvent } from '../bridge/types';

async function* eventsOf(list: readonly BridgeEvent[]): AsyncGenerator<BridgeEvent> {
  for (const event of list) yield event;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('bridgeToResponsesSSE', () => {
  it('frames a normal text turn and terminates with [DONE]', async () => {
    const output = await collect(
      bridgeToResponsesSSE(eventsOf([{ type: 'text_delta', text: 'Hello ' }, { type: 'text_delta', text: 'world' }, { type: 'done' }]), 'chatgpt-web/pro'),
    );
    expect(output).toContain('event: response.created');
    expect(output).toContain('event: response.output_item.added');
    expect(output).toContain('event: response.output_text.delta');
    expect(output).toContain('"delta":"Hello "');
    expect(output).toContain('event: response.output_text.done');
    expect(output).toContain('event: response.content_part.done');
    expect(output).toContain('event: response.completed');
    expect(output.endsWith('data: [DONE]\n\n')).toBe(true);
    // Exactly one terminal frame.
    expect(output.match(/event: response\.completed/g)).toHaveLength(1);
  });

  it('emits reasoning summary deltas when summaries are visible', async () => {
    const output = await collect(
      bridgeToResponsesSSE(
        eventsOf([{ type: 'thinking_delta', thinking: 'pondering' }, { type: 'text_delta', text: 'answer' }, { type: 'done' }]),
        'chatgpt-web/pro',
      ),
    );
    expect(output).toContain('event: response.reasoning_summary_text.delta');
  });

  it('suppresses reasoning entirely under hideThinkingSummary', async () => {
    const output = await collect(
      bridgeToResponsesSSE(
        eventsOf([{ type: 'thinking_delta', thinking: 'secret' }, { type: 'text_delta', text: 'a' }, { type: 'done' }]),
        'chatgpt-web/pro',
        { hideThinkingSummary: true },
      ),
    );
    expect(output).not.toContain('reasoning_summary');
    expect(output).toContain('"delta":"a"');
  });

  it('accumulates compaction turns into one synthetic compaction item', async () => {
    const output = await collect(
      bridgeToResponsesSSE(
        eventsOf([{ type: 'text_delta', text: 'sum' }, { type: 'text_delta', text: 'mary' }, { type: 'done' }]),
        'chatgpt-web/pro',
        { compaction: true },
      ),
    );
    expect(output).not.toContain('response.output_text.delta');
    const item = output.match(/"type":"compaction","id":"cmp_[^"]+","encrypted_content":"([^"]+)"/);
    expect(item).not.toBeNull();
    expect(decodeCompactionSummary(item![1])).toBe('summary');
  });

  it('maps adapter errors to response.failed with the carried status message', async () => {
    const output = await collect(
      bridgeToResponsesSSE(
        eventsOf([{ type: 'error', message: 'boom', status: 502, errorType: 'server_error' }]),
        'chatgpt-web/pro',
      ),
    );
    expect(output).toContain('event: response.failed');
    expect(output).toContain('"message":"boom"');
    expect(output.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('synthesizes response.incomplete when the adapter ends without a terminal event', async () => {
    const output = await collect(
      bridgeToResponsesSSE(eventsOf([{ type: 'text_delta', text: 'partial' }]), 'chatgpt-web/pro'),
    );
    expect(output).toContain('event: response.incomplete');
    expect(output).toContain('adapter_eof');
  });
});

describe('buildResponseJSON', () => {
  it('folds events into one completed response document', () => {
    const document = buildResponseJSON(
      [{ type: 'text_delta', text: 'a' }, { type: 'text_delta', text: 'b' }, { type: 'done' }],
      'chatgpt-web/pro',
    );
    expect(document['status']).toBe('completed');
    const output = document['output'] as Array<{ type: string; content?: Array<{ text: string }> }>;
    expect(output[0]['content']?.[0]?.['text']).toBe('ab');
    expect((document['usage'] as Record<string, number>)['total_tokens']).toBe(0);
  });

  it('marks error turns failed and hides suppressed thinking', () => {
    const document = buildResponseJSON(
      [{ type: 'thinking_delta', thinking: 'x' }, { type: 'error', message: 'nope' }],
      'chatgpt-web/pro',
      { hideThinkingSummary: true },
    );
    expect(document['status']).toBe('failed');
    expect((document['output'] as unknown[])).toHaveLength(0);
  });
});
