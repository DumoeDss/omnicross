import { describe, expect, it } from 'vitest';

import { sanitizeAnthropicReplay, sanitizeAnthropicReplayBody } from '../anthropicReplay';

const signed = { type: 'thinking', thinking: '', signature: 'native-opaque' };
const redacted = { type: 'redacted_thinking', data: 'native-redacted' };
const call = { type: 'tool_use', id: 'call_a', name: 'read', input: { path: 'file.ts' } };
const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'contents' }] };

describe('Claude replay after switching providers', () => {
  it('omits unsigned foreign thinking while preserving native blocks and tool pairs', () => {
    const body = {
      model: 'claude-sonnet-4-6', thinking: { type: 'adaptive' },
      messages: [
        { role: 'user', content: 'read a file' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'foreign' }, signed, redacted, call] },
        result,
      ],
    };
    const before = structuredClone(body);
    const sanitized = sanitizeAnthropicReplay(body);
    expect(sanitized.messages).toEqual([body.messages[0], { role: 'assistant', content: [signed, redacted, call] }, result]);
    expect(sanitized.thinking).toBe(body.thinking);
    expect(body).toEqual(before);
    expect(sanitizeAnthropicReplay(sanitized)).toBe(sanitized);
  });

  it.each([undefined, '', '   ', null])('does not accept a thinking signature of %j', (signature) => {
    const body = { model: 'claude', messages: [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'foreign', signature }, call] }, result,
    ] };
    expect(sanitizeAnthropicReplay(body).messages).toEqual([{ role: 'assistant', content: [call] }, result]);
  });

  it('omits an assistant message made empty by removing unsigned thinking', () => {
    const body = { model: 'claude', messages: [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'foreign' }] },
      { role: 'user', content: 'continue' },
    ] };
    expect(sanitizeAnthropicReplay(body).messages).toEqual([body.messages[1]]);
  });

  it('completes a foreign tool loop without legacy manual thinking and restores it on later turns', () => {
    const body = { model: 'claude-sonnet-4-5', thinking: { type: 'enabled', budget_tokens: 4096 }, messages: [
      { role: 'assistant', content: [call] }, result,
    ] };
    expect(sanitizeAnthropicReplay(body).thinking).toEqual({ type: 'disabled' });
    const next = { ...body, messages: [...body.messages,
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      { role: 'user', content: 'next task' },
    ] };
    expect(sanitizeAnthropicReplay(next)).toBe(next);
    const newUserTurn = { ...body, messages: [...body.messages, { role: 'user', content: 'A new task' }] };
    expect(sanitizeAnthropicReplay(newUserTurn)).toBe(newUserTurn);
  });

  it('preserves signed manual-thinking tool turns and exact original JSON bytes', () => {
    const body = { model: 'claude', thinking: { type: 'enabled', budget_tokens: 4096 }, messages: [
      { role: 'assistant', content: [signed, redacted, call] }, result,
    ] };
    const raw = JSON.stringify(body, null, 2);
    expect(sanitizeAnthropicReplayBody(raw)).toBe(raw);
  });

  it('preserves unsigned thinking for compatible providers and recognizes official aliases', () => {
    const body = { model: 'mimo-v2.5-pro', messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'keep' }, call] }] };
    expect(sanitizeAnthropicReplay(body)).toBe(body);
    expect(sanitizeAnthropicReplay(body, { name: 'claude' })).not.toBe(body);
    expect(sanitizeAnthropicReplay(body, { baseUrl: 'https://api.anthropic.com/v1' })).not.toBe(body);
    expect(sanitizeAnthropicReplay(body, { baseUrl: 'https://api.anthropic.com.example.test/v1' })).toBe(body);
  });
});
