/**
 * OpenAIResponseTransformer — reasoning replay across the reduced chain.
 *
 * DeepSeek v4 thinking mode 400s with "The `reasoning_content` in the thinking
 * mode must be passed back to the API." unless every thinking-turn assistant
 * message in the input carries its `reasoning_content`. The round trip through
 * codex needs BOTH halves tested here:
 *
 *  1. REQUEST decode — a replayed codex `reasoning` input item must be captured
 *     onto the transformer context (keyed by assistant-message index), not
 *     silently skipped; the chat encoder replays it for demanding upstreams.
 *  2. RESPONSE encode — a chat upstream's `reasoning_content` must be framed as
 *     a real `reasoning` OUTPUT ITEM. Bare `reasoning_summary_text.delta`
 *     events belong to no item, so codex dropped them, the reasoning never
 *     reached the rollout, and there was nothing to replay next turn.
 *
 * @module transformer/__tests__/OpenAIResponseTransformer.reasoning.test
 */

import { describe, expect, it } from 'vitest';

import { OpenAIResponseTransformer } from '../transformers/OpenAIResponseTransformer';
import type { TransformerContext } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a text/event-stream Response from a list of raw SSE frame strings. */
function chatSseResponse(frames: string[]): Response {
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

/** A chat.completion.chunk carrying a `reasoning_content` delta. */
function reasoningFrame(delta: string): string {
  return `data: {"id":"cc_1","model":"deepseek-flash","choices":[{"index":0,"delta":{"reasoning_content":${JSON.stringify(delta)}},"finish_reason":null}]}\n\n`;
}

/** A chat.completion.chunk carrying a content delta. */
function contentFrame(delta: string): string {
  return `data: {"id":"cc_1","model":"deepseek-flash","choices":[{"index":0,"delta":{"content":${JSON.stringify(delta)}},"finish_reason":null}]}\n\n`;
}

function finishFrame(reason: string): string {
  return `data: {"id":"cc_1","model":"deepseek-flash","choices":[{"index":0,"delta":{},"finish_reason":${JSON.stringify(reason)}}]}\n\n`;
}

/** A codex-shaped follow-up request: history with two thinking turns. */
function codexFollowUpBody(): Record<string, unknown> {
  return {
    model: 'deepseek-flash',
    stream: true,
    reasoning: { effort: 'high', summary: 'auto' },
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
      // Thinking turn 1: reasoning + tool call + tool result.
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'thinking A' }],
      },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.txt\nb.txt' },
      // Thinking turn 2: reasoning + final assistant message.
      {
        type: 'reasoning',
        id: 'rs_2',
        summary: [{ type: 'summary_text', text: 'thinking B' }],
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'thanks' }] },
    ],
  };
}

// ---------------------------------------------------------------------------
// Request decode — replay capture
// ---------------------------------------------------------------------------

describe('OpenAIResponseTransformer — reasoning replay capture (Responses → unified)', () => {
  const transformer = new OpenAIResponseTransformer();

  it('captures replayed reasoning items onto the context, keyed by assistant message index', async () => {
    const context: TransformerContext = {};
    const unified = (await transformer.transformRequestOut(codexFollowUpBody(), context)) as any;

    // messages: [user, assistant(tool_calls), tool, assistant, user]
    expect(unified.messages.map((m: any) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
    expect(context.responsesReasoningReplay).toEqual([
      { messageIndex: 1, text: 'thinking A' },
      { messageIndex: 3, text: 'thinking B' },
    ]);
  });

  it('emits no message for a reasoning item and no replay when none are replayed', async () => {
    const context: TransformerContext = {};
    const unified = (await transformer.transformRequestOut(
      {
        model: 'deepseek-flash',
        stream: true,
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
        ],
      },
      context
    )) as any;

    expect(unified.messages).toHaveLength(2);
    expect(context.responsesReasoningReplay).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Response encode — streaming reasoning item lifecycle
// ---------------------------------------------------------------------------

describe('OpenAIResponseTransformer — streaming reasoning item lifecycle (chat SSE → Responses SSE)', () => {
  const transformer = new OpenAIResponseTransformer();

  it('frames reasoning_content as a reasoning output item that closes before the message item', async () => {
    const out = await transformer.transformResponseIn(
      chatSseResponse([
        reasoningFrame('Let me '),
        reasoningFrame('think.'),
        contentFrame('Answer.'),
        finishFrame('stop'),
        'data: [DONE]\n\n',
      ]),
      {}
    );
    const events = await drainSseEvents(out);

    // The reasoning item lifecycle, in wire order.
    const added = events.find((e) => e.type === 'response.output_item.added' && e.item?.type === 'reasoning');
    expect(added).toBeDefined();
    expect(String(added.item.id)).toMatch(/^rs_/);
    expect(added.item.summary).toEqual([]);
    expect(added.item.status).toBe('in_progress');

    const partAdded = events.find((e) => e.type === 'response.reasoning_summary_part.added');
    expect(partAdded?.item_id).toBe(added.item.id);
    expect(partAdded?.summary_index).toBe(0);

    const deltas = events.filter((e) => e.type === 'response.reasoning_summary_text.delta');
    expect(deltas.map((e) => e.delta).join('')).toBe('Let me think.');
    for (const delta of deltas) {
      expect(delta.item_id).toBe(added.item.id);
      expect(delta.output_index).toBe(added.output_index);
    }

    const done = events.find((e) => e.type === 'response.output_item.done' && e.item?.type === 'reasoning');
    expect(done.item.summary).toEqual([{ type: 'summary_text', text: 'Let me think.' }]);
    expect(done.item.status).toBe('completed');

    // The reasoning item CLOSES before the message item opens, mirroring the
    // real Responses wire, and rides the terminal response.completed output.
    const messageAdded = events.find(
      (e) => e.type === 'response.output_item.added' && e.item?.type === 'message'
    );
    expect(messageAdded.output_index).toBeGreaterThan(added.output_index);
    const doneIdx = events.findIndex((e) => e.type === 'response.output_item.done' && e.item?.type === 'reasoning');
    const messageAddedIdx = events.findIndex(
      (e) => e.type === 'response.output_item.added' && e.item?.type === 'message'
    );
    expect(doneIdx).toBeGreaterThan(-1);
    expect(messageAddedIdx).toBeGreaterThan(doneIdx);

    const completed = events.find((e) => e.type === 'response.completed');
    expect(completed.response.output[added.output_index]).toMatchObject({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Let me think.' }],
    });
  });

  it('closes the reasoning item before a tool-call item when no prose follows', async () => {
    const out = await transformer.transformResponseIn(
      chatSseResponse([
        reasoningFrame('need the tool'),
        'data: {"id":"cc_1","model":"deepseek-flash","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"exec","arguments":""}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"cc_1","model":"deepseek-flash","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":null}]}\n\n',
        finishFrame('tool_calls'),
        'data: [DONE]\n\n',
      ]),
      {}
    );
    const events = await drainSseEvents(out);

    const reasoningDone = events.findIndex(
      (e) => e.type === 'response.output_item.done' && e.item?.type === 'reasoning'
    );
    const toolAdded = events.findIndex(
      (e) => e.type === 'response.output_item.added' && e.item?.type === 'function_call'
    );
    expect(reasoningDone).toBeGreaterThan(-1);
    expect(toolAdded).toBeGreaterThan(reasoningDone);
  });

  it('still closes a reasoning-only stream at finish', async () => {
    const out = await transformer.transformResponseIn(
      chatSseResponse([reasoningFrame('just thinking'), finishFrame('stop'), 'data: [DONE]\n\n']),
      {}
    );
    const events = await drainSseEvents(out);
    const done = events.find(
      (e) => e.type === 'response.output_item.done' && e.item?.type === 'reasoning'
    );
    expect(done).toBeDefined();
    expect(done.item.summary).toEqual([{ type: 'summary_text', text: 'just thinking' }]);
  });
});

// ---------------------------------------------------------------------------
// Response encode — non-streaming JSON
// ---------------------------------------------------------------------------

describe('OpenAIResponseTransformer — non-streaming reasoning item (chat JSON → Responses JSON)', () => {
  const transformer = new OpenAIResponseTransformer();

  it('surfaces reasoning_content as the first output item', async () => {
    const chatJson = {
      id: 'chatcmpl-1',
      model: 'deepseek-flash',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Answer.',
            reasoning_content: 'Chain of thought.',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };
    const response = new Response(JSON.stringify(chatJson), {
      headers: { 'Content-Type': 'application/json' },
    });

    const out = await transformer.transformResponseIn(response, {});
    const data = (await out.json()) as any;
    expect(data.output[0]).toMatchObject({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Chain of thought.' }],
    });
    expect(data.output[1]).toMatchObject({ type: 'message', role: 'assistant' });
  });
});
