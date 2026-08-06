/**
 * AnthropicConversion — non-streaming JSON tool-call + thinking round-trip tests.
 *
 * Covers the four FIX-scope conversions:
 * - `convertAnthropicResponseToOpenAI` (Anthropic response → OpenAI response)
 * - `convertOpenAIResponseToAnthropic` (OpenAI response → Anthropic response)
 * - `transformAnthropicRequestToUnified` (Anthropic request → Unified request)
 * - `buildAnthropicRequestBody`         (Unified request → Anthropic request)
 *
 * @module transformer/__tests__/AnthropicConversion.test
 */

import { describe, expect, it } from 'vitest';

import {
  buildAnthropicRequestBody,
  convertAnthropicResponseToOpenAI,
  convertOpenAIResponseToAnthropic,
  transformAnthropicRequestToUnified,
} from '../transformers/AnthropicConversion';
import type { UnifiedChatRequest } from '../types';

// ---------------------------------------------------------------------------
// convertAnthropicResponseToOpenAI
// ---------------------------------------------------------------------------

describe('convertAnthropicResponseToOpenAI', () => {
  it('maps plain text to OpenAI choices[0].message', () => {
    const result = convertAnthropicResponseToOpenAI({
      id: 'msg_1',
      model: 'claude-sonnet-4',
      content: [{ type: 'text', text: 'Hello world' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    expect(result.choices[0].message).toEqual({
      role: 'assistant',
      content: 'Hello world',
    });
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('maps tool_use blocks to tool_calls', () => {
    const result = convertAnthropicResponseToOpenAI({
      id: 'msg_2',
      model: 'claude-sonnet-4',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'tool_1', name: 'get_weather', input: { city: 'Tokyo' } },
        { type: 'tool_use', id: 'tool_2', name: 'get_time', input: { zone: 'JST' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    expect(result.choices[0].message.tool_calls).toEqual([
      { id: 'tool_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } },
      { id: 'tool_2', type: 'function', function: { name: 'get_time', arguments: '{"zone":"JST"}' } },
    ]);
    expect(result.choices[0].finish_reason).toBe('tool_calls');
  });

  it('maps server_tool_use blocks to tool_calls', () => {
    const result = convertAnthropicResponseToOpenAI({
      id: 'msg_s',
      model: 'claude-sonnet-4',
      content: [
        { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'ai' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 3, output_tokens: 1 },
    });

    expect(result.choices[0].message.tool_calls).toEqual([
      { id: 'srv_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"ai"}' } },
    ]);
  });

  it('preserves thinking block on the message', () => {
    const result = convertAnthropicResponseToOpenAI({
      id: 'msg_t',
      model: 'claude-sonnet-4',
      content: [
        { type: 'thinking', thinking: 'reasoning here', signature: 'sig_abc' },
        { type: 'text', text: 'Answer.' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    expect(result.choices[0].message.thinking).toEqual({
      content: 'reasoning here',
      signature: 'sig_abc',
    });
  });

  it('sets content to null when only tool_use is present', () => {
    const result = convertAnthropicResponseToOpenAI({
      id: 'msg_toolonly',
      model: 'claude',
      content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    expect(result.choices[0].message.content).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// convertOpenAIResponseToAnthropic
// ---------------------------------------------------------------------------

describe('convertOpenAIResponseToAnthropic', () => {
  it('maps plain text to Anthropic content blocks', () => {
    const result = convertOpenAIResponseToAnthropic({
      id: 'chatcmpl-1',
      model: 'gpt-4',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });

    expect(result.content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(result.stop_reason).toBe('end_turn');
    expect(result.usage).toMatchObject({ input_tokens: 5, output_tokens: 3 });
  });

  it('maps tool_calls to tool_use blocks with parsed input', () => {
    const result = convertOpenAIResponseToAnthropic({
      id: 'chatcmpl-2',
      model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 2, completion_tokens: 4 },
    });

    expect(result.content).toContainEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'f',
      input: { a: 1 },
    });
    expect(result.stop_reason).toBe('tool_use');
  });

  it('falls back to {text: arguments} when arguments JSON is invalid', () => {
    const result = convertOpenAIResponseToAnthropic({
      id: 'c3',
      model: 'm',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c', type: 'function', function: { name: 'n', arguments: 'not-json' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    });

    expect(result.content).toContainEqual({
      type: 'tool_use',
      id: 'c',
      name: 'n',
      input: { text: 'not-json' },
    });
  });

  // thinking MUST be first in the Anthropic content array — the API enforces
  // the ordering thinking → text → tool_use. `buildAnthropicRequestBody` and
  // the streaming converter both emit thinking first; the non-streaming
  // response converter must match.
  it('places thinking block before text and tool_use', () => {
    const result = convertOpenAIResponseToAnthropic({
      id: 'c4',
      model: 'm',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'answer',
          tool_calls: [
            { id: 'tc', type: 'function', function: { name: 'fn', arguments: '{}' } },
          ],
          thinking: { content: 'ponder', signature: 'sig' },
        },
        finish_reason: 'tool_calls',
      }],
    });

    const types = (result.content as Array<Record<string, unknown>>).map(c => c.type);
    expect(types).toEqual(['thinking', 'text', 'tool_use']);
  });

  it('handles cached_tokens in usage details', () => {
    const result = convertOpenAIResponseToAnthropic({
      id: 'c5',
      model: 'm',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hi' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 30 },
      },
    });

    expect(result.usage).toMatchObject({
      input_tokens: 70,  // 100 - 30
      output_tokens: 50,
      cache_read_input_tokens: 30,
    });
  });
});

// ---------------------------------------------------------------------------
// transformAnthropicRequestToUnified
// ---------------------------------------------------------------------------

describe('transformAnthropicRequestToUnified', () => {
  it('extracts string system to a system message', () => {
    const result = transformAnthropicRequestToUnified({
      model: 'claude',
      max_tokens: 1024,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
  });

  it('converts user tool_result to role:tool messages', () => {
    const result = transformAnthropicRequestToUnified({
      model: 'claude',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_1', content: 'result text' },
          ],
        },
      ],
    });

    expect(result.messages).toContainEqual({
      role: 'tool',
      content: 'result text',
      tool_call_id: 'tool_1',
      cache_control: undefined,
    });
  });

  it('flattens a BLOCK-ARRAY tool_result to text (Claude Code sends this shape)', () => {
    // Claude Code returns tool results as content blocks far more often than as
    // a bare string. Stringifying made the upstream model read the literal
    // `[{"type":"text","text":"…"}]` envelope on every single tool result.
    const result = transformAnthropicRequestToUnified({
      model: 'claude',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: [
                { type: 'text', text: 'line one' },
                { type: 'text', text: 'line two' },
              ],
            },
          ],
        },
      ],
    });

    const toolMsg = result.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.content).toBe('line one\nline two');
    expect(typeof toolMsg.content).toBe('string');
  });

  it('replaces an image block in a tool_result with a placeholder, not base64', () => {
    // A chat `tool` message cannot carry image parts; dumping the base64 into
    // the prompt is worse than saying an image was there.
    const result = transformAnthropicRequestToUnified({
      model: 'claude',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: [
                { type: 'text', text: 'screenshot taken' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo…' } },
              ],
            },
          ],
        },
      ],
    });

    const toolMsg = result.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.content).toBe('screenshot taken\n[image omitted]');
    expect(toolMsg.content).not.toContain('iVBORw0KGgo');
  });

  it('converts assistant tool_use to tool_calls', () => {
    const result = transformAnthropicRequestToUnified({
      model: 'claude',
      max_tokens: 1024,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Using tool.' },
            { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'test' } },
          ],
        },
      ],
    });

    const assistant = result.messages.find(m => m.role === 'assistant')!;
    expect(assistant.tool_calls).toEqual([
      { id: 'tu_1', type: 'function', function: { name: 'search', arguments: '{"q":"test"}' } },
    ]);
  });

  it('preserves thinking on assistant messages (even without signature)', () => {
    const result = transformAnthropicRequestToUnified({
      model: 'claude',
      max_tokens: 1024,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'reasoning' } as never,
            { type: 'text', text: 'reply' },
          ],
        },
      ],
    });

    const assistant = result.messages.find(m => m.role === 'assistant')!;
    expect(assistant.thinking).toEqual({ content: 'reasoning', signature: undefined });
  });

  it('maps tool_choice type "tool" to function tool_choice', () => {
    const result = transformAnthropicRequestToUnified({
      model: 'claude',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: { type: 'tool', name: 'my_func' },
    });

    expect(result.tool_choice).toEqual({ type: 'function', function: { name: 'my_func' } });
  });

  it('maps thinking config to reasoning', () => {
    const result = transformAnthropicRequestToUnified({
      model: 'claude',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 8192 },
    });

    expect(result.reasoning).toEqual({ effort: 'medium', enabled: true });
  });
});

// ---------------------------------------------------------------------------
// buildAnthropicRequestBody
// ---------------------------------------------------------------------------

describe('buildAnthropicRequestBody', () => {
  it('extracts system message to top-level field', () => {
    const request: UnifiedChatRequest = {
      model: 'claude',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'hi' },
      ],
    };

    const body = buildAnthropicRequestBody(request);
    expect(body.system).toBe('Be brief.');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  // Anthropic requires `max_tokens`, so an absent caller cap must resolve to
  // the model's real ceiling. Regression: a hardcoded 4096 fallback silently
  // truncated long responses and corrupted tool-call JSON mid-arguments.
  it('defaults max_tokens to the model ceiling, not a small constant', () => {
    const body = buildAnthropicRequestBody({
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'write the chapter' }],
    });

    expect(body.max_tokens).toBe(128000);
    expect(body.max_tokens).not.toBe(4096);
  });

  it('defaults max_tokens to the frontier ceiling for unregistered models', () => {
    const body = buildAnthropicRequestBody({
      model: 'some-relay-only-alias',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(body.max_tokens).toBe(128000);
  });

  it('still honors an explicit max_tokens from the caller', () => {
    const body = buildAnthropicRequestBody({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(body.max_tokens).toBe(1024);
  });

  it('converts assistant tool_calls to tool_use blocks', () => {
    const request: UnifiedChatRequest = {
      model: 'claude',
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'fn', arguments: '{"x":1}' } },
          ],
        },
      ],
    };

    const body = buildAnthropicRequestBody(request);
    const msg = (body.messages as Array<Record<string, unknown>>)[0];
    expect(msg.role).toBe('assistant');
    expect(msg.content).toContainEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'fn',
      input: { x: 1 },
    });
  });

  it('places thinking block before text and tool_use', () => {
    const request: UnifiedChatRequest = {
      model: 'claude',
      messages: [
        {
          role: 'assistant',
          content: 'text body',
          tool_calls: [
            { id: 'c', type: 'function', function: { name: 'n', arguments: '{}' } },
          ],
          thinking: { content: 'thoughts', signature: 's' },
        },
      ],
    };

    const body = buildAnthropicRequestBody(request);
    const msg = (body.messages as Array<Record<string, unknown>>)[0];
    const blocks = msg.content as Array<Record<string, unknown>>;
    const types = blocks.map(b => b.type);
    expect(types).toEqual(['thinking', 'text', 'tool_use']);
  });

  it('groups consecutive tool messages into one user message', () => {
    const request: UnifiedChatRequest = {
      model: 'claude',
      messages: [
        { role: 'tool', content: 'result A', tool_call_id: 'tA' },
        { role: 'tool', content: 'result B', tool_call_id: 'tB' },
        { role: 'user', content: 'next' },
      ],
    };

    const body = buildAnthropicRequestBody(request);
    const msgs = body.messages as Array<Record<string, unknown>>;
    // First message should be a user with two tool_result blocks
    expect(msgs[0].role).toBe('user');
    const blocks = msgs[0].content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tA' });
    expect(blocks[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'tB' });
    // Second message is the user text
    expect(msgs[1]).toEqual({ role: 'user', content: 'next' });
  });

  it('maps reasoning config to thinking with budget', () => {
    const request: UnifiedChatRequest = {
      model: 'claude',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'high', enabled: true },
    };

    const body = buildAnthropicRequestBody(request);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 32768 });
    expect(body.temperature).toBe(1); // thinking forces temperature = 1
  });

  it('converts image_url data URIs to Anthropic image source', () => {
    const request: UnifiedChatRequest = {
      model: 'claude',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,abc123' },
          },
          { type: 'text', text: 'describe' },
        ],
      }],
    };

    const body = buildAnthropicRequestBody(request);
    const msg = (body.messages as Array<Record<string, unknown>>)[0];
    const blocks = msg.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
    });
  });
});
