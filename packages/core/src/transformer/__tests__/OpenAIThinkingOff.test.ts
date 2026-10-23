import { getPresetById } from '@omnicross/contracts/provider-presets';
import { describe, expect, it } from 'vitest';

import { TransformerChainExecutor } from '../TransformerChainExecutor';
import { OpenAIResponseTransformer } from '../transformers/OpenAIResponseTransformer';
import { OpenAITransformer } from '../transformers/OpenAITransformer';
import type { LLMProvider, Transformer, UnifiedChatRequest } from '../types';

const provider: LLMProvider = {
  name: 'openai',
  baseUrl: 'https://api.openai.com',
  apiKey: 'test-key',
  models: [],
};

function request(overrides: Partial<UnifiedChatRequest> = {}): UnifiedChatRequest {
  return {
    model: 'gpt-5.1',
    messages: [{ role: 'user', content: 'Answer briefly.' }],
    ...overrides,
  };
}

async function wireBody(
  encoder: Transformer,
  input: unknown,
  targetProvider = provider,
  decoder?: Transformer,
): Promise<Record<string, any>> {
  const result = await new TransformerChainExecutor().executeRequestChain(
    input,
    targetProvider,
    { providerTransformers: [encoder], modelTransformers: [] },
    { endpointTransformer: decoder },
  );
  return JSON.parse(JSON.stringify(result.requestBody));
}

for (const format of ['chat', 'responses'] as const) {
  const encoder = format === 'chat'
    ? new OpenAITransformer()
    : new OpenAIResponseTransformer();
  const effortOf = (body: Record<string, any>) => format === 'chat'
    ? body.reasoning_effort
    : body.reasoning?.effort;

  describe(`OpenAI ${format} serialized reasoning policy`, () => {
    it.each([
      ['absent', undefined, undefined],
      ['explicit none', { effort: 'none', enabled: false }, 'none'],
      ['none without enabled', { effort: 'none' }, 'none'],
      ['disabled overrides high', { effort: 'high', enabled: false }, 'none'],
      ['high', { effort: 'high', enabled: true }, 'high'],
    ] as const)('preserves %s policy on a supported model', async (_name, reasoning, expected) => {
      const body = await wireBody(encoder, request({ reasoning }));
      expect(effortOf(body)).toBe(expected);
      if (expected === undefined) {
        expect(body).not.toHaveProperty(format === 'chat' ? 'reasoning_effort' : 'reasoning');
      }
      if (format === 'chat') expect(body).not.toHaveProperty('reasoning');
      if (format === 'responses' && expected === 'none') {
        expect(body.reasoning).toEqual({ effort: 'none' });
      }
    });

    it.each(['o3', 'gpt-5.3-codex'])(
      'rejects unsupported explicit off for %s before producing a wire body',
      async (model) => {
        await expect(wireBody(encoder, request({
          model,
          reasoning: { effort: 'none', enabled: false },
        }))).rejects.toThrow();
      },
    );

    it('omits reasoning controls for a non-reasoning target', async () => {
      const body = await wireBody(encoder, request({
        model: 'gpt-4o',
        reasoning: { effort: 'none', enabled: false },
      }), {
        ...provider,
        modelConfigs: [{ id: 'gpt-4o', reasoning: false }],
      });
      expect(body).not.toHaveProperty(format === 'chat' ? 'reasoning_effort' : 'reasoning');
    });

    it('uses provider-row support for an otherwise unknown model', async () => {
      const body = await wireBody(encoder, request({
        model: 'custom-reasoner',
        reasoning: { enabled: false },
      }), {
        ...provider,
        modelConfigs: [{ id: 'custom-reasoner', reasoning: true, thinkingLevels: ['none', 'high'] }],
      });
      expect(effortOf(body)).toBe('none');
    });

    it('honors a row that removes canonical disabling support', async () => {
      await expect(wireBody(encoder, request({
        reasoning: { effort: 'none', enabled: false },
      }), {
        ...provider,
        modelConfigs: [{ id: 'gpt-5.1', thinkingLevels: ['low', 'medium', 'high'] }],
      })).rejects.toThrow();
    });

    it('omits effort for canonical and overridden no-effort targets', async () => {
      const canonical = await wireBody(encoder, request({
        model: 'grok-4.20-0309-non-reasoning',
        reasoning: { enabled: false },
      }));
      const overridden = await wireBody(encoder, request({
        reasoning: { enabled: false },
      }), {
        ...provider,
        modelConfigs: [{ id: 'gpt-5.1', thinkingLevels: ['none'] }],
      });
      const field = format === 'chat' ? 'reasoning_effort' : 'reasoning';
      expect(canonical).not.toHaveProperty(field);
      expect(overridden).not.toHaveProperty(field);
    });

    it('keeps existing enabled-effort negotiation', async () => {
      const body = await wireBody(encoder, request({
        model: 'custom-reasoner',
        reasoning: { effort: 'xhigh', enabled: true },
      }), {
        ...provider,
        modelConfigs: [{ id: 'custom-reasoner', thinkingLevels: ['low', 'high'] }],
      });
      expect(effortOf(body)).toBe('high');
    });
  });
}

describe('OpenAI native intent and cross-format conversion', () => {
  it.each(['none', 'xhigh'])('preserves native Chat %s without a unified override', async (effort) => {
    const body = await wireBody(new OpenAITransformer(), request({
      model: 'unknown-model',
      reasoning_effort: effort,
    }));
    expect(body.reasoning_effort).toBe(effort);
  });

  it('lets explicit unified off override native Chat high', async () => {
    const body = await wireBody(new OpenAITransformer(), request({
      reasoning_effort: 'high',
      reasoning: { enabled: false },
    }));
    expect(body.reasoning_effort).toBe('none');
  });

  it('rejects an unsupported unified off override instead of forwarding native Chat high', async () => {
    await expect(wireBody(new OpenAITransformer(), request({
      model: 'o3',
      reasoning_effort: 'high',
      reasoning: { enabled: false },
    }))).rejects.toThrow();
  });

  it('converts native Chat none into supported Responses none', async () => {
    const body = await wireBody(new OpenAIResponseTransformer(), request({ reasoning_effort: 'none' }));
    expect(body.reasoning.effort).toBe('none');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('converts Responses none through the real decoder into supported Chat none', async () => {
    const body = await wireBody(new OpenAITransformer(), {
      model: 'gpt-5.1',
      input: [{ role: 'user', content: 'Answer briefly.' }],
      reasoning: { effort: 'none' },
    }, provider, new OpenAIResponseTransformer());
    expect(body.reasoning_effort).toBe('none');
    expect(body).not.toHaveProperty('reasoning');
  });

  it('rejects decoded Responses none for an unsupported Chat target', async () => {
    await expect(wireBody(new OpenAITransformer(), {
      model: 'o3',
      input: [{ role: 'user', content: 'Answer briefly.' }],
      reasoning: { effort: 'none' },
    }, provider, new OpenAIResponseTransformer())).rejects.toThrow();
  });

  it.each(['none', 'xhigh'])('preserves native Responses %s and summary on a same-format round trip', async (effort) => {
    const transformer = new OpenAIResponseTransformer();
    const context = {};
    const unified = await transformer.transformRequestOut({
      model: 'unknown-model',
      input: [{ role: 'user', content: 'Answer briefly.' }],
      reasoning: { effort, summary: 'concise' },
    }, context);
    const result = await transformer.transformRequestIn(unified, provider, context);
    const body = JSON.parse(JSON.stringify(result.body));
    expect(body.reasoning).toEqual({ effort, summary: 'concise' });
  });

  it('replaces decoded Responses high without rebuilding opaque native input', async () => {
    const transformer = new OpenAIResponseTransformer();
    const context = {};
    const incoming = {
      model: 'gpt-5.1',
      input: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-reasoning', summary: [] },
        { role: 'user', content: [
          { type: 'input_text', text: 'Answer briefly.' },
          { type: 'input_image', image_url: 'https://example.com/image.png', detail: 'high' },
        ] },
      ],
      reasoning: { effort: 'high', summary: 'concise' },
      include: ['reasoning.encrypted_content'],
      tools: [{ type: 'web_search_preview', search_context_size: 'low' }],
      max_output_tokens: 4096,
    };
    const unified = await transformer.transformRequestOut(incoming, context);
    unified.reasoning = { enabled: false };
    const result = await transformer.transformRequestIn(unified, provider, context);
    const body = JSON.parse(JSON.stringify(result.body));
    expect(body).toEqual({ ...incoming, reasoning: { effort: 'none', summary: 'concise' } });
  });

  it('rejects an unsupported override without taking the native Responses bypass', async () => {
    const transformer = new OpenAIResponseTransformer();
    const context = {};
    const unified = await transformer.transformRequestOut({
      model: 'o3',
      input: [{ role: 'user', content: 'Answer briefly.' }],
      reasoning: { effort: 'high', summary: 'concise' },
    }, context);
    unified.reasoning = { enabled: false };
    await expect(transformer.transformRequestIn(unified, provider, context)).rejects.toThrow();
  });
});

describe('DeepSeek Chat Completions serialized reasoning policy', () => {
  const preset = getPresetById('deepseek')!;
  const deepseek: LLMProvider = {
    name: preset.name,
    baseUrl: preset.api_base_url,
    apiKey: 'test-key',
    models: preset.models,
    modelConfigs: preset.modelConfigs,
  };

  it.each(preset.models)('uses the thinking toggle for unified and native %s off', async (model) => {
    for (const stream of [false, true]) {
      for (const policy of [
        { reasoning: { effort: 'none' as const, enabled: false } },
        { reasoning: { enabled: false }, reasoning_effort: 'high' as const },
        { reasoning_effort: 'none' as const },
      ]) {
        const body = await wireBody(
          new OpenAITransformer(), request({ model, stream, ...policy }), deepseek,
        );
        expect(body.thinking).toEqual({ type: 'disabled' });
        expect(body).not.toHaveProperty('reasoning_effort');
        expect(body).not.toHaveProperty('reasoning');
        expect(body.stream).toBe(stream);
      }
      const responses = await wireBody(new OpenAIResponseTransformer(), request({
        model, stream, reasoning: { effort: 'none', enabled: false },
      }), deepseek);
      expect(responses.reasoning).toEqual({ effort: 'none' });
      expect(responses).not.toHaveProperty('thinking');
    }
  });

  it.each(['low', 'high', 'max'] as const)('preserves supported DeepSeek %s effort on both wires', async (effort) => {
    for (const model of preset.models) {
      const input = request({ model, reasoning: { effort, enabled: true } });
      const chat = await wireBody(new OpenAITransformer(), input, deepseek);
      expect(chat.reasoning_effort).toBe(effort);
      expect(chat.thinking).toEqual({ type: 'enabled' });
      const responses = await wireBody(new OpenAIResponseTransformer(), input, deepseek);
      expect(responses.reasoning.effort).toBe(effort);
      expect(responses).not.toHaveProperty('thinking');
    }
  });

  it.each(['default', 'disabled', 'unsupported-off'] as const)(
    'preserves required tool-continuation replay unless the outgoing wire disables it: %s',
    async (policy) => {
      const model = preset.models[0];
      const target: LLMProvider = policy === 'unsupported-off'
        ? { ...deepseek, modelConfigs: [{ id: model, thinkingLevels: ['high', 'max'] }] }
        : deepseek;
      const bodyPromise = wireBody(new OpenAITransformer(), {
        model,
        ...(policy === 'default' ? {} : { reasoning: { effort: 'none' } }),
        input: [
          { type: 'message', role: 'user', content: 'List files.' },
          { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Call the file tool.' }] },
          { type: 'function_call', call_id: 'call_1', name: 'list_files', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
        ],
      }, target, new OpenAIResponseTransformer());
      if (policy === 'unsupported-off') {
        await expect(bodyPromise).rejects.toThrow();
        return;
      }
      const body = await bodyPromise;

      expect(body).not.toHaveProperty('reasoning_effort');
      const assistant = body.messages.find((message: { role: string }) => message.role === 'assistant');
      expect(assistant.tool_calls).toEqual([
        { id: 'call_1', type: 'function', function: { name: 'list_files', arguments: '{}' } },
      ]);
      expect(body.messages.at(-1)).toMatchObject({
        role: 'tool', tool_call_id: 'call_1', content: 'a.txt',
      });
      if (policy === 'disabled') {
        expect(body.thinking).toEqual({ type: 'disabled' });
        expect(assistant).not.toHaveProperty('reasoning_content');
      } else {
        expect(body).not.toHaveProperty('thinking');
        expect(assistant.reasoning_content).toBe('Call the file tool.');
      }
    },
  );
});

describe('Native Chat off-encoding boundaries', () => {
  it.each([
    ['grok', 'grok-4.5'],
    ['grok', 'grok-4.3'],
    ['xiaomi-mimo', 'mimo-v2.5'],
    ['xiaomi-mimo', 'mimo-v2.5-pro'],
    ['xiaomi-mimo', 'mimo-v2-pro'],
    ['xiaomi-mimo', 'mimo-v2.6-pro'],
  ])('preserves native %s / %s off-encoding boundaries', async (presetId, model) => {
    const preset = getPresetById(presetId)!;
    const native: LLMProvider = {
      name: preset.name,
      baseUrl: preset.api_base_url,
      apiKey: 'test-key',
      models: preset.models,
      modelConfigs: preset.modelConfigs,
    };
    const defaultBody = await wireBody(new OpenAITransformer(), request({ model }), native);
    expect(defaultBody).not.toHaveProperty('reasoning_effort');
    expect(defaultBody).not.toHaveProperty('thinking');
    for (const policy of [
      { reasoning: { effort: 'none' as const, enabled: false } },
      { reasoning_effort: 'none' as const },
    ]) {
      const bodyPromise = wireBody(new OpenAITransformer(), request({ model, ...policy }), native);
      if (presetId === 'grok') {
        await expect(bodyPromise).rejects.toThrow();
        continue;
      }
      const body = await bodyPromise;
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body).not.toHaveProperty('thinking');
    }
  });

  it('rejects unsupported off for Copilot-native Gemini Chat', async () => {
    const copilot: LLMProvider = {
      name: 'GitHub Copilot',
      baseUrl: 'https://api.githubcopilot.com',
      apiKey: 'test-key',
      models: ['gemini-3.5-flash'],
    };
    await expect(wireBody(new OpenAITransformer(), request({
      model: 'gemini-3.5-flash',
      reasoning: { effort: 'none', enabled: false },
    }), copilot)).rejects.toThrow();
  });
});

describe('Native Responses off-encoding boundaries', () => {
  it.each([
    ['grok', 'grok-4.5'],
    ['xiaomi-mimo', 'mimo-v2.5'],
    ['kimi', 'kimi-k2.5'],
  ])('does not infer Responses effort:none from %s native Chat support', async (presetId, model) => {
    const preset = getPresetById(presetId)!;
    const native: LLMProvider = {
      name: preset.name,
      baseUrl: preset.api_base_url,
      apiKey: 'test-key',
      models: preset.models,
      modelConfigs: preset.modelConfigs,
    };
    const defaultBody = await wireBody(new OpenAIResponseTransformer(), request({ model }), native);
    expect(defaultBody).not.toHaveProperty('reasoning');
    for (const policy of [
      { reasoning: { effort: 'none' as const, enabled: false } },
      { reasoning_effort: 'none' as const },
    ]) {
      const bodyPromise = wireBody(new OpenAIResponseTransformer(), request({ model, ...policy }), native);
      if (presetId === 'grok') {
        await expect(bodyPromise).rejects.toThrow();
        continue;
      }
      const body = await bodyPromise;
      expect(body).not.toHaveProperty('reasoning');
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body).not.toHaveProperty('thinking');
    }
  });
});
