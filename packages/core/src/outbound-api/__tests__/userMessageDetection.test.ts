/**
 * Unit tests for the 4-format user-message detector (`omnicross-uqc-core`, task
 * 6.3). For each ingress format: a plain human turn → `true`, its tool-loop
 * continuation → `false`, and an unclassifiable body → `false` (safety bias
 * toward bypass).
 */
import { describe, expect, it } from 'vitest';

import { isUserMessageRequest } from '../userMessageDetection';

describe('isUserMessageRequest — anthropic messages', () => {
  it('true for a trailing user turn (string or text-block content)', () => {
    expect(isUserMessageRequest('messages', { messages: [{ role: 'user', content: 'hi' }] })).toBe(
      true,
    );
    expect(
      isUserMessageRequest('messages', {
        messages: [
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: [{ type: 'text', text: 'go on' }] },
        ],
      }),
    ).toBe(true);
  });

  it('false when the last user turn carries a tool_result block', () => {
    expect(
      isUserMessageRequest('messages', {
        messages: [
          { role: 'user', content: 'call the tool' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
        ],
      }),
    ).toBe(false);
  });

  it('false for unclassifiable / non-user-tail bodies', () => {
    expect(isUserMessageRequest('messages', {})).toBe(false);
    expect(
      isUserMessageRequest('messages', { messages: [{ role: 'assistant', content: 'x' }] }),
    ).toBe(false);
  });
});

describe('isUserMessageRequest — openai responses', () => {
  it('true for a string input or a trailing user message item', () => {
    expect(isUserMessageRequest('responses', { input: 'hello there' })).toBe(true);
    expect(
      isUserMessageRequest('responses', {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      }),
    ).toBe(true);
  });

  it('false when the last item is a function_call_output (tool result)', () => {
    expect(
      isUserMessageRequest('responses', {
        input: [
          { type: 'message', role: 'user', content: 'run it' },
          { type: 'function_call', call_id: 'c1', name: 'x', arguments: '{}' },
          { type: 'function_call_output', call_id: 'c1', output: '42' },
        ],
      }),
    ).toBe(false);
  });

  it('false for unclassifiable bodies', () => {
    expect(isUserMessageRequest('responses', {})).toBe(false);
    expect(isUserMessageRequest('responses', { input: [] })).toBe(false);
  });
});

describe('isUserMessageRequest — openai chat', () => {
  it('true for a trailing user message', () => {
    expect(isUserMessageRequest('chat', { messages: [{ role: 'user', content: 'hi' }] })).toBe(true);
  });

  it('false when the last message is a tool result', () => {
    expect(
      isUserMessageRequest('chat', {
        messages: [
          { role: 'user', content: 'call it' },
          { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'c1', content: 'done' },
        ],
      }),
    ).toBe(false);
  });

  it('false for unclassifiable bodies', () => {
    expect(isUserMessageRequest('chat', {})).toBe(false);
    expect(isUserMessageRequest('chat', { messages: [{ role: 'assistant', content: 'x' }] })).toBe(
      false,
    );
  });
});

describe('isUserMessageRequest — gemini generateContent', () => {
  it('true for a trailing user content with plain text parts', () => {
    expect(
      isUserMessageRequest('gemini', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    ).toBe(true);
  });

  it('false when the trailing user content carries a functionResponse part', () => {
    expect(
      isUserMessageRequest('gemini', {
        contents: [
          { role: 'user', parts: [{ text: 'call it' }] },
          { role: 'model', parts: [{ functionCall: { name: 'x', args: {} } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'x', response: { ok: true } } }] },
        ],
      }),
    ).toBe(false);
  });

  it('false for unclassifiable / non-user-tail bodies', () => {
    expect(isUserMessageRequest('gemini', {})).toBe(false);
    expect(
      isUserMessageRequest('gemini', { contents: [{ role: 'model', parts: [{ text: 'x' }] }] }),
    ).toBe(false);
  });
});
