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
import {
  markReasoningReplayRequired,
  reasoningReplayKey,
  resetReasoningReplayStateForTests,
} from '../transformers/utils/reasoningReplay';

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

  it('drops the Anthropic decoder\'s _serverSideTools stash', async () => {
    // The Anthropic→Unified decode stashes server-side tools (web_search_20250305,
    // …) on the request for the Anthropic→Anthropic round-trip. On this wire
    // they have no representation; leaking the stash as a top-level field gets
    // the whole request rejected by Anthropic-relaying upstreams with
    // "Extra inputs are not permitted, field: '_serverSideTools'".
    const out = await encode(
      req({
        _serverSideTools: [{ type: 'web_search_20250305', name: 'web_search' }],
      } as unknown as Partial<UnifiedChatRequest>),
    );
    expect(out).not.toHaveProperty('_serverSideTools');
    // Everything else still rides the passthrough untouched.
    expect(out.model).toBe('deepseek-v4-pro');
  });
});

describe('OpenAITransformer — reasoning effort', () => {
  it('encodes reasoning.effort as reasoning_effort', async () => {
    const out = await encode(req({ reasoning: { effort: 'high', enabled: true } }));
    expect(out.reasoning_effort).toBe('high');
    // The Anthropic-shaped object itself is not leaked.
    expect(out).not.toHaveProperty('reasoning');
  });

  it('serializes supported explicit off instead of relying on the upstream default', async () => {
    const openai = {
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
    } as LLMProvider;
    const out = JSON.parse(JSON.stringify(await new OpenAITransformer().transformRequestIn(
      req({ model: 'gpt-5.1', reasoning: { effort: 'none', enabled: false } }),
      openai,
      ctx,
    )));
    expect(out.reasoning_effort).toBe('none');
    expect(out).not.toHaveProperty('reasoning');
  });

  it('negotiates exact minimal/xhigh and nearest sparse levels', async () => {
    expect((await encode(req({
      model: 'gpt-5.2',
      reasoning: { effort: 'minimal', enabled: true },
    }))).reasoning_effort).toBe('minimal');
    expect((await encode(req({
      model: 'gpt-5.3-codex',
      reasoning: { effort: 'xhigh', enabled: true },
    }))).reasoning_effort).toBe('xhigh');
    expect((await encode(req({
      model: 'deepseek-v4-pro',
      reasoning: { effort: 'xhigh', enabled: true },
    }))).reasoning_effort).toBe('max');
  });

  it('leaves native Chat reasoning_effort untouched without unified reasoning', async () => {
    const out = await encode(req({ reasoning_effort: 'xhigh' }));
    expect(out.reasoning_effort).toBe('xhigh');
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

describe('OpenAITransformer — structured-output fallback', () => {
  const schema = {
    type: 'object',
    properties: { step: { type: 'string' } },
    required: ['step'],
  };
  const jsonSchemaFormat = {
    type: 'json_schema',
    json_schema: { name: 'codex_output_schema', strict: true, schema },
  };

  it('downgrades json_schema to json_object on a DeepSeek provider and keeps the schema in the prompt', async () => {
    // DeepSeek answers 400 "This response_format type is unavailable now" for
    // json_schema (v4-flash and v4-pro, measured 2026-10-20). Forwarding it
    // killed codex's `exec --output-schema` and TUI recap turns outright.
    const out = await encode(req({ response_format: jsonSchemaFormat } as Partial<UnifiedChatRequest>));
    expect(out.response_format).toEqual({ type: 'json_object' });

    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.role).toBe('system');
    expect(String(messages[0]?.content)).toContain('JSON Schema');
    expect(String(messages[0]?.content)).toContain('"step"');
    // The original turn is intact behind the inserted instruction.
    expect(messages[1]).toMatchObject({ role: 'user', content: 'hi' });
  });

  it('leaves json_schema untouched for a provider that supports strict schemas', async () => {
    const openai = {
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
    } as unknown as LLMProvider;
    const out = await new OpenAITransformer().transformRequestIn(
      req({ response_format: jsonSchemaFormat } as Partial<UnifiedChatRequest>),
      openai,
      ctx,
    );
    expect(out.response_format).toEqual(jsonSchemaFormat);
    expect((out.messages as Array<Record<string, unknown>>)[0]?.role).toBe('user');
  });

  it('leaves an existing json_object format untouched', async () => {
    const out = await encode(
      req({ response_format: { type: 'json_object' } } as Partial<UnifiedChatRequest>),
    );
    expect(out.response_format).toEqual({ type: 'json_object' });
    expect((out.messages as Array<Record<string, unknown>>)[0]?.role).toBe('user');
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

describe('OpenAITransformer — reasoning replay from a Responses client', () => {
  // The Reduced-chain companion to the thinking round trip above: codex replays
  // its `reasoning` items, the Responses ingress stashes them on the shared
  // context, and the chat encoder writes them back as `reasoning_content` for
  // upstreams that demand it (DeepSeek v4 thinking mode) — and nobody else.
  const deepseekProvider = {
    name: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
  } as unknown as LLMProvider;
  const zaiProvider = { name: 'z-ai', baseUrl: 'https://api.z.ai' } as unknown as LLMProvider;

  function replayContext(
    entries: Array<{ messageIndex: number; text: string }>,
  ): TransformerContext {
    return { responsesReasoningReplay: entries } as TransformerContext;
  }

  const history: Array<Record<string, unknown>> = [
    { role: 'user', content: 'list files' },
    { role: 'assistant', content: null, tool_calls: [] },
    { role: 'tool', content: 'a.txt', tool_call_id: 'call_1' },
    { role: 'assistant', content: 'done' },
  ];
  const replay = [
    { messageIndex: 1, text: 'thinking A' },
    { messageIndex: 3, text: 'thinking B' },
  ];

  it('replays reasoning_content for a thinking request on DeepSeek v4', async () => {
    const out = await new OpenAITransformer().transformRequestIn(
      req({ model: 'deepseek-flash', messages: history as never, reasoning: { effort: 'high', enabled: true } }),
      deepseekProvider,
      replayContext(replay),
    );
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(out.reasoning_effort).toBeDefined();
    expect(messages[1]?.reasoning_content).toBe('thinking A');
    expect(messages[3]?.reasoning_content).toBe('thinking B');
    expect(messages[0]?.reasoning_content).toBeUndefined();
    expect(messages[2]?.reasoning_content).toBeUndefined();
  });

  it('replays for DeepSeek default-on thinking even without an effort field', async () => {
    const out = await new OpenAITransformer().transformRequestIn(
      req({ model: 'deepseek-flash', messages: history as never }),
      deepseekProvider,
      replayContext(replay),
    );
    expect(out.reasoning_effort).toBeUndefined();
    expect(out).not.toHaveProperty('thinking');
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[1]?.reasoning_content).toBe('thinking A');
    expect(messages[3]?.reasoning_content).toBe('thinking B');
  });

  it('translates native explicit none into the actual disabled toggle and suppresses replay', async () => {
    const out = await new OpenAITransformer().transformRequestIn(
      req({ model: 'deepseek-flash', messages: history as never, reasoning_effort: 'none' }),
      deepseekProvider,
      replayContext(replay),
    );
    expect(out.thinking).toEqual({ type: 'disabled' });
    expect(out).not.toHaveProperty('reasoning_effort');
    for (const message of out.messages as Array<Record<string, unknown>>) {
      expect(message.reasoning_content).toBeUndefined();
    }
  });

  it('stays silent for legacy deepseek-reasoner and for other providers', async () => {
    for (const [provider, model] of [
      [deepseekProvider, 'deepseek-reasoner'],
      [zaiProvider, 'glm-5.3'],
    ] as const) {
      const out = await new OpenAITransformer().transformRequestIn(
        req({ model, messages: history as never, reasoning: { effort: 'high', enabled: true } }),
        provider,
        replayContext(replay),
      );
      for (const message of out.messages as Array<Record<string, unknown>>) {
        expect(message.reasoning_content).toBeUndefined();
      }
    }
  });

  it('replays once the provider is learned from a live rejection and the wire is not off', async () => {
    try {
      markReasoningReplayRequired(reasoningReplayKey(zaiProvider));
      // No reasoning intent at all — the observed 400 proved the demand.
      const out = await new OpenAITransformer().transformRequestIn(
        req({ model: 'glm-5.3', messages: history as never }),
        zaiProvider,
        replayContext(replay),
      );
      const messages = out.messages as Array<Record<string, unknown>>;
      expect(messages[1]?.reasoning_content).toBe('thinking A');
    } finally {
      resetReasoningReplayStateForTests();
    }
  });

  it.each(['disabled-toggle', 'native-none', 'unsupported-off'] as const)(
    'gates learned replay on actual outgoing off controls: %s',
    async (policy) => {
      const provider = policy === 'disabled-toggle' ? deepseekProvider : zaiProvider;
      try {
        markReasoningReplayRequired(reasoningReplayKey(provider));
        const out = JSON.parse(JSON.stringify(await new OpenAITransformer().transformRequestIn(
          req({
            model: policy === 'disabled-toggle' ? 'deepseek-flash' : 'glm-5.3',
            messages: history as never,
            ...(policy === 'native-none'
              ? { reasoning_effort: 'none' }
              : { reasoning: { enabled: false } }),
          }),
          provider,
          replayContext(replay),
        )));
        if (policy === 'unsupported-off') {
          expect(out).not.toHaveProperty('reasoning_effort');
          expect(out).not.toHaveProperty('thinking');
          expect(out.messages[1].reasoning_content).toBe('thinking A');
        } else {
          if (policy === 'disabled-toggle') {
            expect(out.thinking).toEqual({ type: 'disabled' });
            expect(out).not.toHaveProperty('reasoning_effort');
          } else {
            expect(out.reasoning_effort).toBe('none');
          }
          expect(out.messages[1]).not.toHaveProperty('reasoning_content');
        }
      } finally {
        resetReasoningReplayStateForTests();
      }
    },
  );
});
