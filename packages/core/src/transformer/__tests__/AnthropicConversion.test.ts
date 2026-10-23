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
import { buildRequestBody as buildGeminiRequestBody } from '../transformers/utils/gemini.util';
import { transformResponseOut as decodeGeminiResponse } from '../transformers/utils/gemini.stream';

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

  it('preserves cache_read_input_tokens through the usage conversion (hero regression)', () => {
    // Real z.ai Anthropic-endpoint shape: input_tokens EXCLUDES cache, cache
    // read is reported alongside. Pre-fix this dropped the cache field and the
    // dashboard showed 0 cache read for a 99%-cached turn.
    const result = convertAnthropicResponseToOpenAI({
      id: 'msg_cache',
      model: 'glm-5.2',
      content: [{ type: 'text', text: 'Hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 52, output_tokens: 321, cache_read_input_tokens: 7040 },
    });
    expect(result.usage).toEqual({
      prompt_tokens: 7092, // 52 fresh + 7040 cached
      completion_tokens: 321,
      total_tokens: 7413,
      prompt_tokens_details: { cached_tokens: 7040 },
    });
  });

  it('folds cache_creation_input_tokens into prompt_tokens (no OpenAI equivalent)', () => {
    const result = convertAnthropicResponseToOpenAI({
      id: 'msg_create',
      model: 'claude-sonnet-4',
      content: [{ type: 'text', text: 'Hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200 },
    });
    expect(result.usage).toEqual({
      prompt_tokens: 300, // 100 fresh + 200 cache-create, billed at input rate
      completion_tokens: 50,
      total_tokens: 350,
    });
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

  it('does not turn a provider-executed server tool into a client tool call', () => {
    expect(() => convertAnthropicResponseToOpenAI({
      content: [{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'ai' } }],
    })).toThrow('Unsupported Anthropic response block: server_tool_use');
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
      blocks: [{ type: 'thinking', thinking: 'reasoning here', signature: 'sig_abc' }],
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

  it('rejects invalid tool arguments rather than fabricating a different tool input', () => {
    expect(() => convertOpenAIResponseToAnthropic({
      choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'n', arguments: 'not-json' } }] } }],
    })).toThrow('Invalid JSON arguments');
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

  it('preserves in-message system instructions alongside the top-level system prompt', () => {
    const inline = { type: 'text', text: 'Additional instructions.', cache_control: { type: 'ephemeral' } };
    const result = transformAnthropicRequestToUnified({
      model: 'deepseek-flash',
      max_tokens: 4096,
      system: 'Primary instructions.',
      messages: [
        { role: 'user', content: 'Run the task.' },
        { role: 'system', content: [inline] },
        { role: 'system', content: 'Final instructions.' },
      ],
    });
    expect(result.messages).toEqual([
      { role: 'system', content: 'Primary instructions.' },
      { role: 'user', content: 'Run the task.' },
      { role: 'system', content: [inline] },
      { role: 'system', content: 'Final instructions.' },
    ]);
    expect(buildAnthropicRequestBody(result)).toMatchObject({
      system: [
        { type: 'text', text: 'Primary instructions.' },
        inline,
        { type: 'text', text: 'Final instructions.' },
      ],
      messages: [{ role: 'user', content: 'Run the task.' }],
    });
  });

  it('rejects tool calls inside in-message system instructions', () => {
    expect(() => transformAnthropicRequestToUnified({
      model: 'deepseek-flash',
      max_tokens: 4096,
      messages: [{ role: 'system', content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: {} }] }],
    })).toThrow('Anthropic system messages only support text');
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

  it('preserves tool-result text blocks through a complete round trip', () => {
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

    expect(buildAnthropicRequestBody(result).messages).toEqual([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: [
        { type: 'text', text: 'line one' }, { type: 'text', text: 'line two' },
      ] }] },
    ]);
  });

  it('preserves screenshot tool results as images rather than placeholders', () => {
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

    expect(buildAnthropicRequestBody(result).messages).toEqual([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: [
        { type: 'text', text: 'screenshot taken' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo…' } },
      ] }] },
    ]);
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

    expect(buildAnthropicRequestBody(result).messages).toEqual([
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: 'reply' }] },
    ]);
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

    expect(result.reasoning).toEqual({ effort: 'medium', enabled: true, max_tokens: 8192 });
  });

  it('decodes adaptive effort, explicit disablement, and malformed values safely', () => {
    const adaptive = transformAnthropicRequestToUnified({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'MAX' },
    });
    expect(adaptive.reasoning).toEqual({ effort: 'max', enabled: true });

    const disabled = transformAnthropicRequestToUnified({
      model: 'claude',
      max_tokens: 1024,
      messages: [],
      thinking: { type: 'disabled' },
    });
    expect(disabled.reasoning).toEqual({ effort: 'none', enabled: false });

    expect(() => transformAnthropicRequestToUnified({
      model: 'claude',
      max_tokens: 1024,
      messages: [],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'turbo' },
    })).toThrow('Unsupported Anthropic effort');
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

  // codex sends `parallel_tool_calls:false` on every request; Anthropic spells
  // the inverse inside tool_choice. The field must never appear verbatim.
  it('encodes parallel_tool_calls:false as disable_parallel_tool_use on an implicit auto choice', () => {
    const body = buildAnthropicRequestBody({
      model: 'claude',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'fn', description: '', parameters: { type: 'object' } } }],
      parallel_tool_calls: false,
    });

    expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect('parallel_tool_calls' in body).toBe(false);
  });

  it('merges disable_parallel_tool_use into an explicit mapped choice', () => {
    const body = buildAnthropicRequestBody({
      model: 'claude',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'fn', description: '', parameters: { type: 'object' } } }],
      tool_choice: 'required',
      parallel_tool_calls: false,
    });

    expect(body.tool_choice).toEqual({ type: 'any', disable_parallel_tool_use: true });
  });

  it('omits tool_choice entirely when no tools are declared', () => {
    const body = buildAnthropicRequestBody({
      model: 'claude',
      messages: [{ role: 'user', content: 'hi' }],
      parallel_tool_calls: false,
    });

    expect(body.tool_choice).toBeUndefined();
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

  it('encodes adaptive thinking with negotiated effort for declared targets', () => {
    const body = buildAnthropicRequestBody({
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'minimal', enabled: true },
    });
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.temperature).toBeUndefined();
  });

  it('extracts native OpenAI Chat effort during cross-format adaptive encoding', () => {
    const body = buildAnthropicRequestBody({
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'xhigh',
    });
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'max' });
  });

  it('honors and clamps explicit legacy budgets against provider bounds', () => {
    const provider = {
      modelConfigs: [{
        id: 'legacy-claude',
        thinkingTokenLimit: { min: 1024, max: 4096 },
      }],
    };
    const body = buildAnthropicRequestBody({
      model: 'legacy-claude',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'high', enabled: true, max_tokens: 9000 },
    }, provider);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
    expect(body.temperature).toBe(1);
  });

  it('uses legacy budget encoding when an empty row override shadows canonical levels', () => {
    const body = buildAnthropicRequestBody({
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'high', enabled: true, max_tokens: 2048 },
    }, {
      modelConfigs: [{
        id: 'claude-opus-4-6',
        thinkingLevels: [],
        thinkingTokenLimit: { min: 1024, max: 4096 },
      }],
    });

    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(body).not.toHaveProperty('output_config');
    expect(body.temperature).toBe(1);
  });

  it.each<NonNullable<UnifiedChatRequest['reasoning']>>([
    { effort: 'none', enabled: false },
    { effort: 'none' },
    { effort: 'high', enabled: false },
  ])('serializes explicit off instead of the default-on request policy: %j', (reasoning) => {
    const defaultOn: UnifiedChatRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 4096,
      temperature: 0.4,
      stream: true,
      stop: ['done'],
      metadata_user_id: 'role-request',
      reasoning: { effort: 'high', enabled: true },
    };
    const enabledWire = JSON.parse(JSON.stringify(buildAnthropicRequestBody(defaultOn)));
    const disabledWire = JSON.parse(JSON.stringify(buildAnthropicRequestBody({
      ...defaultOn,
      reasoning,
    })));

    expect(enabledWire.thinking).toEqual({ type: 'adaptive' });
    expect(enabledWire.output_config).toEqual({ effort: 'high' });
    expect(disabledWire).toEqual({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 4096,
      temperature: 0.4,
      stream: true,
      stop_sequences: ['done'],
      metadata: { user_id: 'role-request' },
      thinking: { type: 'disabled' },
    });
  });

  it('preserves explicit disabled thinking through decode and serialized re-encoding', () => {
    const incoming = {
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 4096,
      temperature: 0.6,
      stream: false,
      thinking: { type: 'disabled' },
    };
    const unified = transformAnthropicRequestToUnified(JSON.parse(JSON.stringify(incoming)));
    const wire = JSON.parse(JSON.stringify(buildAnthropicRequestBody(unified)));

    expect(unified.reasoning).toEqual({ effort: 'none', enabled: false });
    expect(wire).toEqual(incoming);
  });

  it('keeps absent thinking policy absent through decode and serialized re-encoding', () => {
    const incoming = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 4096,
      temperature: 0.6,
      stream: false,
    };
    const unified = transformAnthropicRequestToUnified(incoming);
    const wire = JSON.parse(JSON.stringify(buildAnthropicRequestBody(unified)));

    expect(unified.reasoning).toBeUndefined();
    expect(wire).toEqual(incoming);
  });

  it.each([
    { model: 'claude-opus-4-6', thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
    { model: 'legacy-claude', thinking: { type: 'enabled', budget_tokens: 2048 } },
  ])('preserves existing enabled thinking on the serialized $model wire', (thinkingConfig) => {
    const incoming = {
      ...thinkingConfig,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 4096,
      temperature: 1,
      stream: false,
    };
    const unified = transformAnthropicRequestToUnified(incoming);
    const wire = JSON.parse(JSON.stringify(buildAnthropicRequestBody(unified)));

    expect(wire).toEqual(incoming);
  });

  it.each(['unknown-model', 'gpt-4o'])('does not infer off support for %s', (model) => {
    const wire = JSON.parse(JSON.stringify(buildAnthropicRequestBody({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'none', enabled: false },
      temperature: 0.4,
    })));

    expect(wire).not.toHaveProperty('thinking');
    expect(wire).not.toHaveProperty('output_config');
    expect(wire.temperature).toBe(0.4);
  });

  it('encodes native Chat none for a provider-declared off-capable target', () => {
    const wire = JSON.parse(JSON.stringify(buildAnthropicRequestBody({
      model: 'custom-anthropic',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'none',
    }, {
      modelConfigs: [{
        id: 'custom-anthropic',
        thinkingLevels: ['none', 'high'],
      }],
    })));

    expect(wire.thinking).toEqual({ type: 'disabled' });
    expect(wire).not.toHaveProperty('output_config');
    expect(wire).not.toHaveProperty('temperature');
  });

  it('serializes disabled legacy thinking independently of its enabled minimum budget', () => {
    const incoming = {
      model: 'legacy-anthropic',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 4096,
      temperature: 0.4,
      stream: false,
      thinking: { type: 'disabled' },
    };
    const unified = transformAnthropicRequestToUnified(incoming);
    const wire = JSON.parse(JSON.stringify(buildAnthropicRequestBody(unified, {
      modelConfigs: [{
        id: 'legacy-anthropic',
        thinkingTokenLimit: { min: 1024, max: 4096 },
      }],
    })));

    expect(wire).toEqual(incoming);
  });

  it('does not override a provider declaration that excludes disabled thinking', () => {
    expect(() => buildAnthropicRequestBody({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'none', enabled: false },
    }, {
      modelConfigs: [{
        id: 'claude-sonnet-4-6',
        thinkingLevels: ['low', 'high'],
      }],
    })).toThrow();
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

describe('reasoning and parallel tool replay', () => {
  it('preserves native Chat reasoning into Claude and the next parallel tool-result turn', () => {
    const response = convertOpenAIResponseToAnthropic({
      id: 'deepseek-turn', model: 'deepseek-flash',
      choices: [{ message: {
        role: 'assistant', reasoning_content: 'Compare both cities.', content: null,
        tool_calls: [
          { id: 'a', function: { name: 'weather', arguments: '{"city":"A"}' } },
          { id: 'b', function: { name: 'weather', arguments: '{"city":"B"}' } },
        ],
      }, finish_reason: 'tool_calls' }],
    });
    expect(response.content).toEqual([
      { type: 'thinking', thinking: 'Compare both cities.' },
      { type: 'tool_use', id: 'a', name: 'weather', input: { city: 'A' } },
      { type: 'tool_use', id: 'b', name: 'weather', input: { city: 'B' } },
    ]);
    const messages = [
      { role: 'assistant', content: response.content },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'sunny' },
        { type: 'tool_result', tool_use_id: 'b', content: 'timeout', is_error: true },
      ] },
    ];
    const replay = buildAnthropicRequestBody(transformAnthropicRequestToUnified({
      model: 'claude', messages,
    }));
    expect(replay.messages).toEqual(messages);
  });

  it('round-trips multiple signed and redacted response blocks without embedding signatures in text', () => {
    const content = [
      { type: 'thinking', thinking: 'one', signature: 'opaque-1' },
      { type: 'redacted_thinking', data: 'encrypted' },
      { type: 'thinking', thinking: 'two', signature: 'opaque-2' },
      { type: 'text', text: 'answer' },
    ];
    const unified = convertAnthropicResponseToOpenAI({ content, stop_reason: 'end_turn' });
    expect(convertOpenAIResponseToAnthropic(unified).content).toEqual(content);
  });

  it('retains every system instruction and explicit tool-choice restrictions', () => {
    const body = buildAnthropicRequestBody({
      model: 'claude', messages: [
        { role: 'system', content: 'first' }, { role: 'system', content: 'second' },
        { role: 'user', content: 'hello' },
      ], tool_choice: 'none',
    });
    expect(body.system).toEqual([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }]);
    expect(body.tool_choice).toEqual({ type: 'none' });
    const decoded = transformAnthropicRequestToUnified({
      model: 'claude', messages: [], tool_choice: { type: 'any', disable_parallel_tool_use: true },
    });
    expect(decoded.tool_choice).toBe('required');
    expect(decoded.parallel_tool_calls).toBe(false);
  });

  it('rejects unrepresentable request content instead of deleting it', () => {
    expect(() => transformAnthropicRequestToUnified({
      model: 'claude', messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'file', file_id: 'f' } }] }],
    })).toThrow('Unsupported Anthropic content block: document');
  });
});

describe('Anthropic native capabilities', () => {
  it('retains completed server search sources without asking the client to execute the search', () => {
    const result = convertAnthropicResponseToOpenAI({
      content: [
        { type: 'server_tool_use', id: 's', name: 'web_search', input: { query: 'weather' } },
        { type: 'web_search_tool_result', tool_use_id: 's', content: [
          { type: 'web_search_result', title: 'Weather', url: 'https://example.com/weather', encrypted_content: 'opaque' },
        ] },
        { type: 'text', text: 'Sunny.', citations: [{ type: 'web_search_result_location', title: 'Weather', url: 'https://example.com/weather' }] },
      ],
      stop_reason: 'end_turn',
    });
    expect(result.choices[0].message.content).toContain('[Weather](https://example.com/weather)');
    expect(result.choices[0].message.content).toContain('Sunny.');
    expect(result.choices[0].message.content).not.toContain('opaque');
    expect(result.choices[0].message.tool_calls).toBeUndefined();
  });

  it('replays provider-defined client tools without inventing their JSON schemas', () => {
    const tools = [{ type: 'computer_20250124', name: 'computer', display_width_px: 1024, display_height_px: 768 }];
    const request = transformAnthropicRequestToUnified({ model: 'claude', messages: [], tools });
    expect(buildAnthropicRequestBody(request).tools).toEqual(tools);
  });

  it('negotiates MiniMax adaptive thinking without unsupported effort and retains explicit disabled', () => {
    expect(buildAnthropicRequestBody({
      model: 'MiniMax-M3', messages: [], reasoning: { effort: 'high', enabled: true },
    })).toMatchObject({ thinking: { type: 'adaptive' } });
    expect(buildAnthropicRequestBody({
      model: 'MiniMax-M3', messages: [], reasoning: { effort: 'high', enabled: true },
    })).not.toHaveProperty('output_config');
    expect(buildAnthropicRequestBody({
      model: 'MiniMax-M3', messages: [], reasoning: { effort: 'none', enabled: false },
    }).thinking).toEqual({ type: 'disabled' });
  });
});

describe('foreign signature gateway extensions', () => {
  it('replays Gemini signed parts after a Claude client echoes extended content and returns parallel tool results', async () => {
    const parts = [
      { text: 'Compare cities.', thought: true, thoughtSignature: 'google-thought' },
      { functionCall: { id: 'a', name: 'weather', args: { city: 'A' } }, thoughtSignature: 'google-tool-a' },
      { functionCall: { id: 'b', name: 'weather', args: { city: 'B' } }, thoughtSignature: 'google-tool-b' },
    ];
    const unifiedResponse = await decodeGeminiResponse(Response.json({
      candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    }), 'google');
    const claude = convertOpenAIResponseToAnthropic(await unifiedResponse.json());
    const echoed = JSON.parse(JSON.stringify(claude.content));
    const next = transformAnthropicRequestToUnified({
      model: 'gemini-3.1-pro-preview',
      messages: [
        { role: 'assistant', content: echoed },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'sunny' },
          { type: 'tool_result', tool_use_id: 'b', content: 'rainy' },
        ] },
      ],
    });
    const wire = buildGeminiRequestBody(next);
    expect(wire.contents[0]).toEqual({ role: 'model', parts });
    expect(JSON.stringify(wire.contents)).toContain('"functionResponse"');
    expect(echoed.filter((block: { type: string }) => block.type === 'thinking')).toEqual([
      { type: 'thinking', thinking: 'Compare cities.', extra_content: { google: { parts } } },
    ]);
  });
});
