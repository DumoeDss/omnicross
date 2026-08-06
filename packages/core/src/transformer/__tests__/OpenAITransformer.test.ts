/**
 * OpenAITransformer — the format-axis encoder for OpenAI Chat Completions.
 *
 * The load-bearing case is the THINKING ROUND TRIP. An Anthropic-ingress decode
 * attaches `thinking` to assistant history messages; a reasoning upstream
 * requires that reasoning echoed back as `reasoning_content` on the next
 * tool-result turn, or it rejects the request. The response direction already
 * had `reasoning_content → thinking_delta` (`convertOpenAIStreamToAnthropic`),
 * but nothing produced `reasoning_content` on the way OUT — the round trip was
 * open, and the two vendor sanitizers that stood here DROPPED the field.
 *
 * The other half is the blacklist discipline: a whitelist encoder silently eats
 * every chat parameter `UnifiedChatRequest` never declared, including
 * `stream_options.include_usage` — the only reason a chat stream emits a final
 * usage chunk.
 *
 * @module transformer/__tests__/OpenAITransformer.test
 */

import { describe, expect, it } from 'vitest';

import { OpenAITransformer } from '../transformers/OpenAITransformer';
import type { LLMProvider, TransformerContext, UnifiedChatRequest } from '../types';

const provider = { name: 'deepseek', baseUrl: 'https://api.deepseek.com' } as unknown as LLMProvider;
const ctx = { providerName: 'deepseek' } as unknown as TransformerContext;

function req(overrides: Partial<UnifiedChatRequest> = {}): UnifiedChatRequest {
  return {
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  } as UnifiedChatRequest;
}

async function encode(request: UnifiedChatRequest): Promise<Record<string, unknown>> {
  return new OpenAITransformer().transformRequestIn(request, provider, ctx);
}

describe('OpenAITransformer — thinking round trip', () => {
  it('encodes an assistant message thinking block as reasoning_content', async () => {
    const out = await encode(
      req({
        messages: [
          { role: 'user', content: 'call the tool' },
          {
            role: 'assistant',
            content: null,
            thinking: { content: 'I should call it', signature: 'sig_abc' },
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'ls', arguments: '{}' } },
            ],
          },
          { role: 'tool', content: 'a.txt', tool_call_id: 'call_1' },
        ],
      }),
    );
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[1]?.reasoning_content).toBe('I should call it');
    // The Anthropic-only spellings never reach the wire.
    expect(messages[1]).not.toHaveProperty('thinking');
    expect(messages[1]).not.toHaveProperty('signature');
    // The tool round trip is intact — this is a multi-round tool conversation.
    expect(messages[1]?.tool_calls).toHaveLength(1);
    expect(messages[2]?.tool_call_id).toBe('call_1');
  });

  it('omits reasoning_content when a message carries no thinking', async () => {
    const out = await encode(req());
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]).not.toHaveProperty('reasoning_content');
  });

  it('omits reasoning_content for an empty thinking block', async () => {
    const out = await encode(
      req({ messages: [{ role: 'assistant', content: 'x', thinking: { content: '' } }] }),
    );
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]).not.toHaveProperty('reasoning_content');
  });
});

describe('OpenAITransformer — foreign field stripping', () => {
  it('drops internal routing meta (never serialised to an upstream)', async () => {
    const out = await encode(
      req({ meta: { sessionId: 's1', engineOrigin: 'completion' } } as Partial<UnifiedChatRequest>),
    );
    expect(out).not.toHaveProperty('meta');
  });

  it('drops message-level and content-level cache_control', async () => {
    const out = await encode(
      req({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
            ],
            cache_control: { type: 'ephemeral' },
          },
        ],
      }),
    );
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]).not.toHaveProperty('cache_control');
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(content[0]).not.toHaveProperty('cache_control');
    expect(content[0]?.text).toBe('a');
    // Multi-block content stays an array — that IS the chat wire's vision shape.
    expect(content).toHaveLength(2);
  });

  it('drops a top-level Anthropic-shaped thinking config', async () => {
    const out = await encode(
      req({ thinking: { type: 'enabled', budget_tokens: 4096 } } as Partial<UnifiedChatRequest>),
    );
    expect(out).not.toHaveProperty('thinking');
  });
});

describe('OpenAITransformer — reasoning effort', () => {
  it('encodes reasoning.effort as reasoning_effort', async () => {
    const out = await encode(req({ reasoning: { effort: 'high', enabled: true } }));
    expect(out.reasoning_effort).toBe('high');
    // The Anthropic-shaped object itself is not leaked.
    expect(out).not.toHaveProperty('reasoning');
  });

  it("omits reasoning_effort for effort 'none' (the wire spells it by absence)", async () => {
    const out = await encode(req({ reasoning: { effort: 'none', enabled: false } }));
    expect(out).not.toHaveProperty('reasoning_effort');
    expect(out).not.toHaveProperty('reasoning');
  });
});

describe('OpenAITransformer — blacklist discipline (no silent parameter loss)', () => {
  it('passes through chat parameters UnifiedChatRequest never declared', async () => {
    // A whitelist encoder would drop every one of these. `stream_options` is the
    // sharpest: without it a chat stream emits no final usage chunk, so the
    // ingress usage tap never fires and streaming spend silently reads as zero.
    const extras = {
      stream_options: { include_usage: true },
      top_p: 0.9,
      seed: 42,
      stop: ['\n\n'],
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      response_format: { type: 'json_object' },
      parallel_tool_calls: false,
      user: 'u-1',
    };
    const out = await encode(req({ stream: true, ...extras } as Partial<UnifiedChatRequest>));
    for (const [key, value] of Object.entries(extras)) {
      expect(out[key], `${key} must survive the encode`).toEqual(value);
    }
    expect(out.stream).toBe(true);
    expect(out.model).toBe('deepseek-v4-pro');
  });

  it('preserves declared request fields (tools, tool_choice, sampling, max_tokens)', async () => {
    const tools = [
      {
        type: 'function' as const,
        function: { name: 'ls', description: 'list', parameters: { type: 'object' as const, properties: {} } },
      },
    ];
    const out = await encode(req({ tools, tool_choice: 'auto', temperature: 0.5, max_tokens: 128 }));
    expect(out.tools).toEqual(tools);
    expect(out.tool_choice).toBe('auto');
    expect(out.temperature).toBe(0.5);
    expect(out.max_tokens).toBe(128);
  });

  it('preserves a message `name` field (multi-participant conversations)', async () => {
    const out = await encode(
      req({ messages: [{ role: 'user', content: 'hi', name: 'alice' }] } as Partial<UnifiedChatRequest>),
    );
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.name).toBe('alice');
  });
});

describe('OpenAITransformer — content normalization', () => {
  it('collapses a lone text block to a plain string', async () => {
    const out = await encode(
      req({ messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] }),
    );
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.content).toBe('ping');
  });

  it('leaves a string content untouched and preserves an explicit null', async () => {
    const strOut = await encode(req({ messages: [{ role: 'user', content: 'ping' }] }));
    expect((strOut.messages as Array<Record<string, unknown>>)[0]?.content).toBe('ping');
    // `content: null` is how an assistant tool-call turn is spelled.
    const nullOut = await encode(
      req({
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
          },
        ],
      }),
    );
    expect((nullOut.messages as Array<Record<string, unknown>>)[0]?.content).toBeNull();
  });
});

describe('OpenAITransformer — response direction', () => {
  it('is identity: reasoning_content stays the Unified spelling on this path', async () => {
    // On the /v1/chat/completions ingress the client wire IS Unified and there is
    // no endpoint transformer to re-encode, so rewriting the field here would
    // hand an OpenAI SDK something it cannot read.
    const body = JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok', reasoning_content: 'thought' } }],
    });
    const input = new Response(body, { headers: { 'Content-Type': 'application/json' } });
    const out = await new OpenAITransformer().transformResponseOut(input, ctx);
    expect(out).toBe(input);
    const json = (await out.json()) as { choices: Array<{ message: Record<string, unknown> }> };
    expect(json.choices[0]?.message?.reasoning_content).toBe('thought');
  });
});

describe('OpenAITransformer — registration contract', () => {
  it('names the openai format axis slot', () => {
    expect(OpenAITransformer.TransformerName).toBe('openai');
    expect(new OpenAITransformer().name).toBe('openai');
  });
});
