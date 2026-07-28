/**
 * OpenCodeGoTransformer — tool-call round-trip + field-idiosyncrasy tests.
 *
 * OpenCodeGo's chat-shape upstream speaks OpenAI Chat Completions natively, so
 * `OpenCodeGoTransformer` is a thin normalizer (not a format converter). These
 * tests verify the audit rubric from `fix-omni-conversions`:
 *
 *   1. Tool-call REQUEST: `tool_calls` on assistant turns and `tool_call_id` on
 *      tool-result turns survive the normalization (so IDs round-trip across
 *      turns).
 *   2. Tool-call RESPONSE streaming: a streaming `Response` carrying
 *      `tool_calls` deltas is passed through byte-identical (NOT dropped — the
 *      "streaming converter that only handles text deltas" bug class cannot
 *      apply here because `transformResponseOut` does not parse the stream).
 *   3. Non-streaming JSON: tool calls present in the buffered response body
 *      pass through unchanged.
 *   4. Field idiosyncrasies: Anthropic-only `thinking` / `cache_control`
 *      attached by the endpoint transformer are stripped before the request
 *      hits the OpenAI-shape upstream; `reasoning_effort` is emitted in the
 *      OpenAI Chat form.
 *
 * @module transformer/__tests__/OpenCodeGoTransformer.test
 */

import { describe, expect, it } from 'vitest';

import { OpenCodeGoTransformer } from '../transformers/OpenCodeGoTransformer';
import type {
  LLMProvider,
  TransformerContext,
  UnifiedChatRequest,
  UnifiedMessage,
} from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockProvider: LLMProvider = {
  name: 'opencodego',
  baseUrl: 'https://opencode.ai/zen/go/v1/chat/completions',
  apiKey: '',
  models: [],
};

const mockContext: TransformerContext = {
  providerName: 'opencodego',
};

const transformer = new OpenCodeGoTransformer();

// ---------------------------------------------------------------------------
// Request: transformRequestIn
// ---------------------------------------------------------------------------

describe('OpenCodeGoTransformer.transformRequestIn — tool-call round-trip', () => {
  it('preserves tool_calls on assistant messages so IDs round-trip across turns', async () => {
    const assistantWithTools: UnifiedMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_abc123',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
        },
        {
          id: 'toolu_xyz', // Anthropic-style id round-trips through the unified IR
          type: 'function',
          function: { name: 'glob', arguments: '{"pattern":"**/*.md"}' },
        },
      ],
    };

    const request: UnifiedChatRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'What is the weather in Tokyo?' },
        assistantWithTools,
      ],
      stream: true,
    };

    const result = (await transformer.transformRequestIn(
      request,
      mockProvider,
      mockContext,
    )) as Record<string, unknown>;
    const messages = result.messages as Array<Record<string, unknown>>;

    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.tool_calls).toEqual(assistantWithTools.tool_calls);
    // The assistant content (null) is preserved — not rewritten to a string.
    expect(assistant!.content).toBeNull();
  });

  it('preserves tool-result messages with tool_call_id (the round-trip handle)', async () => {
    const request: UnifiedChatRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'call the tool' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_abc',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
            },
          ],
        },
        {
          role: 'tool',
          content: '{"temp":72}',
          tool_call_id: 'call_abc',
        },
      ],
      stream: false,
    };

    const result = (await transformer.transformRequestIn(
      request,
      mockProvider,
      mockContext,
    )) as Record<string, unknown>;
    const messages = result.messages as Array<Record<string, unknown>>;

    const toolMessage = messages.find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.tool_call_id).toBe('call_abc');
    expect(toolMessage!.content).toBe('{"temp":72}');
  });

  it('passes request.tools and request.tool_choice through to the upstream', async () => {
    const request: UnifiedChatRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'use a tool' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ],
      tool_choice: 'auto',
    };

    const result = (await transformer.transformRequestIn(
      request,
      mockProvider,
      mockContext,
    )) as Record<string, unknown>;

    expect(result.tools).toEqual(request.tools);
    expect(result.tool_choice).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// Request: field idiosyncrasies
// ---------------------------------------------------------------------------

describe('OpenCodeGoTransformer.transformRequestIn — field idiosyncrasies', () => {
  it('strips Anthropic-only `thinking` from assistant messages (leaked by AnthropicConversion)', async () => {
    // Multi-turn conversation where the prior assistant turn carried thinking
    // content. AnthropicConversion.transformAnthropicRequestToUnified attaches
    // `thinking` to the unified message; the OpenCodeGo chat upstream is
    // OpenAI-shape and would reject / ignore the field.
    const request: UnifiedChatRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'think then call the tool' },
        {
          role: 'assistant',
          content: 'calling tool',
          thinking: { content: 'Let me consider...', signature: 'sig_abc' },
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'run', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', content: 'ok', tool_call_id: 'call_1' },
      ],
    };

    const result = (await transformer.transformRequestIn(
      request,
      mockProvider,
      mockContext,
    )) as Record<string, unknown>;
    const messages = result.messages as Array<Record<string, unknown>>;

    for (const m of messages) {
      expect(m).not.toHaveProperty('thinking');
    }
    // The tool call itself survives.
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant!.tool_calls).toBeDefined();
    expect(assistant!.tool_calls).toHaveLength(1);
  });

  it('strips Anthropic-only `cache_control` from messages and tool-result turns', async () => {
    const request: UnifiedChatRequest = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'tool',
          content: 'result',
          tool_call_id: 'call_1',
          // AnthropicConversion sets this on tool-result turns.
          cache_control: { type: 'ephemeral' },
        },
      ],
    };

    const result = (await transformer.transformRequestIn(
      request,
      mockProvider,
      mockContext,
    )) as Record<string, unknown>;
    const messages = result.messages as Array<Record<string, unknown>>;

    const toolMessage = messages.find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.tool_call_id).toBe('call_1');
    expect(toolMessage).not.toHaveProperty('cache_control');
  });

  it('drops `meta` (internal routing metadata) from the serialized body', async () => {
    const request: UnifiedChatRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      meta: {
        messageId: 'msg_1',
        sessionId: 'sess_1',
        engineOrigin: 'completion',
        apiKeyId: 'key_1',
      },
    };

    const result = (await transformer.transformRequestIn(
      request,
      mockProvider,
      mockContext,
    )) as Record<string, unknown>;

    expect(result).not.toHaveProperty('meta');
  });

  it('flattens single-text-block content arrays to plain strings', async () => {
    const request: UnifiedChatRequest = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello world' }],
        },
      ],
    };

    const result = (await transformer.transformRequestIn(
      request,
      mockProvider,
      mockContext,
    )) as Record<string, unknown>;
    const messages = result.messages as Array<Record<string, unknown>>;

    expect(messages[0]!.content).toBe('hello world');
  });

  it('keeps multi-block content as an array (image + text)', async () => {
    const request: UnifiedChatRequest = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,abc' },
            },
          ],
        },
      ],
    };

    const result = (await transformer.transformRequestIn(
      request,
      mockProvider,
      mockContext,
    )) as Record<string, unknown>;
    const messages = result.messages as Array<Record<string, unknown>>;

    expect(Array.isArray(messages[0]!.content)).toBe(true);
    expect((messages[0]!.content as unknown[])).toHaveLength(2);
  });

  it('emits reasoning_effort (OpenAI Chat form) when reasoning.effort is set', async () => {
    const request: UnifiedChatRequest = {
      model: 'o3',
      messages: [{ role: 'user', content: 'think hard' }],
      reasoning: { effort: 'high' },
    };

    const result = (await transformer.transformRequestIn(
      request,
      mockProvider,
      mockContext,
    )) as Record<string, unknown>;

    expect(result.reasoning_effort).toBe('high');
    // The Anthropic-style `reasoning` object is NOT leaked.
    expect(result).not.toHaveProperty('reasoning');
  });

  it('omits reasoning_effort when effort is "none"', async () => {
    const request: UnifiedChatRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'none' },
    };

    const result = (await transformer.transformRequestIn(
      request,
      mockProvider,
      mockContext,
    )) as Record<string, unknown>;

    expect(result).not.toHaveProperty('reasoning_effort');
  });

  it('preserves role mapping (user/assistant/system/tool)', async () => {
    const request: UnifiedChatRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'be helpful' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'tool', content: 'data', tool_call_id: 'c1' },
      ],
    };

    const result = (await transformer.transformRequestIn(
      request,
      mockProvider,
      mockContext,
    )) as Record<string, unknown>;
    const roles = (result.messages as Array<Record<string, unknown>>).map(
      (m) => m.role,
    );

    expect(roles).toEqual(['system', 'user', 'assistant', 'tool']);
  });
});

// ---------------------------------------------------------------------------
// Response: transformResponseOut (streaming + non-streaming passthrough)
// ---------------------------------------------------------------------------

/** Build a text/event-stream Response from raw SSE frame strings. */
function sseResponse(frames: string[]): Response {
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
async function drainSseEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: Array<Record<string, unknown>> = [];

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

describe('OpenCodeGoTransformer.transformResponseOut — streaming tool-call passthrough', () => {
  it("does NOT drop tool_calls deltas from the upstream's SSE stream", async () => {
    // Real OpenAI Chat Completions stream shape with a tool_call. The classic
    // bug class is a streaming converter that handles only content deltas and
    // silently drops tool_calls events. `transformResponseOut` here is a pure
    // passthrough, so every tool_calls delta must reach the caller intact.
    const frames = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_xyz","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Tokyo\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const inResp = sseResponse(frames);
    const outResp = await transformer.transformResponseOut(inResp, mockContext);

    expect(outResp.headers.get('Content-Type')).toContain('text/event-stream');
    const events = await drainSseEvents(outResp);

    // The opening tool_call delta carries id + name + empty arguments.
    const openCalls = events
      .flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? [])
      .filter((tc: Record<string, unknown>) => tc.id !== undefined);
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0]).toEqual({
      index: 0,
      id: 'call_xyz',
      type: 'function',
      function: { name: 'get_weather', arguments: '' },
    });

    // The argument fragments concatenate back to the original JSON.
    const argsText = events
      .flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? [])
      .filter(
        (tc: Record<string, unknown>) =>
          tc.function?.arguments !== undefined && tc.id === undefined,
      )
      .map((tc: Record<string, unknown>) =>
        (tc.function as { arguments: string }).arguments,
      )
      .join('');
    expect(argsText).toBe('{"city":"Tokyo"}');

    // The terminal chunk finishes with `tool_calls` (NOT `stop`).
    const finalChunk = events.find(
      (e) => e.choices?.[0]?.finish_reason !== null && e.choices?.[0]?.finish_reason !== undefined,
    );
    expect(finalChunk).toBeDefined();
    expect(finalChunk!.choices[0].finish_reason).toBe('tool_calls');
  });

  it('passes a text-only stream through unchanged (regression)', async () => {
    const frames = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"!"}}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const outResp = await transformer.transformResponseOut(sseResponse(frames), mockContext);
    const events = await drainSseEvents(outResp);

    const text = events
      .map((e) => e.choices?.[0]?.delta?.content ?? '')
      .join('');
    expect(text).toBe('Hi!');

    const anyToolCall = events.some((e) => e.choices?.[0]?.delta?.tool_calls);
    expect(anyToolCall).toBe(false);
  });
});

describe('OpenCodeGoTransformer.transformResponseOut — non-streaming JSON tool-call passthrough', () => {
  it('preserves tool_calls in the buffered JSON response', async () => {
    // Non-streaming OpenAI Chat Completions response with tool_calls. The
    // buffered body must carry the tool calls so a non-streaming client (or
    // the ingress that aggregates SSE for a non-streaming client) sees them.
    const body = {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"city":"Tokyo"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    const inResp = new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const outResp = await transformer.transformResponseOut(inResp, mockContext);
    expect(outResp.status).toBe(200);

    const data = (await outResp.json()) as typeof body;
    const choice = data.choices[0];
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.tool_calls).toHaveLength(1);
    expect(choice.message.tool_calls[0]).toEqual({
      id: 'call_abc',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
    });
  });
});
