import type { LLMProvider } from '@omnicross/contracts/llm-config';
import { getPresetById } from '@omnicross/contracts/provider-presets';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../ports/logger';
import { TransformerChainExecutor } from '../../transformer/TransformerChainExecutor';
import { OpenAIResponseTransformer } from '../../transformer/transformers/OpenAIResponseTransformer';
import { OpenAITransformer } from '../../transformer/transformers/OpenAITransformer';
import type { LLMProvider as TransformerProvider } from '../../transformer/types';
import { callOpenAICompletion, callOpenAIResponseCompletion } from '../DirectApiHandler';
import { streamOpenAICompletion, streamOpenAIResponseCompletion } from '../StreamHandler';
import type { CompletionOptions } from '../types';

const preset = getPresetById('kimi');
if (!preset) throw new Error('Canonical Kimi preset is missing');
const provider: LLMProvider = { ...preset, api_key: 'test-key', enabled: true };
const transformerProvider: TransformerProvider = {
  name: provider.name,
  baseUrl: provider.api_base_url,
  apiKey: 'test-key',
  models: provider.models,
  modelConfigs: provider.modelConfigs,
};
const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
let bodies: Array<Record<string, unknown>>;

async function encode(input: unknown, fromResponses = false): Promise<Record<string, unknown>> {
  const result = await new TransformerChainExecutor().executeRequestChain(
    input,
    transformerProvider,
    { providerTransformers: [new OpenAITransformer()], modelTransformers: [] },
    { endpointTransformer: fromResponses ? new OpenAIResponseTransformer() : undefined },
  );
  return JSON.parse(JSON.stringify(result.requestBody));
}

beforeEach(() => {
  bodies = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response('synthetic stop', { status: 400 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Canonical Kimi K3 reasoning wire policy', () => {
  it.each(['low', 'high', 'max'] as const)(
    'negotiates %s in unified, direct and streaming Chat producers without a K2.x toggle',
    async (thinkLevel) => {
      const unified = await encode({
        model: 'kimi-k3',
        messages: [{ role: 'user', content: 'Answer briefly.' }],
        reasoning: { effort: thinkLevel, enabled: true },
      });
      const options: CompletionOptions = {
        providerId: provider.id,
        model: 'kimi-k3',
        thinkLevel,
        messages: [{ id: 'user-1', role: 'user', content: 'Answer briefly.', timestamp: 1 }],
      };
      await callOpenAICompletion(provider, 'test-key', options, logger);
      await streamOpenAICompletion(provider, 'test-key', options, 'stream-1', {}, logger);

      expect(bodies).toHaveLength(2);
      for (const body of [unified, ...bodies]) {
        expect(body.reasoning_effort).toBe(thinkLevel);
        expect(body).not.toHaveProperty('thinking');
        expect(body).not.toHaveProperty('reasoning');
      }
    },
  );

  it('rejects explicit K3 off in unified, native, direct and streaming producers before HTTP', async () => {
    const messages = [{ role: 'user', content: 'Answer briefly.' }];
    await expect(encode({
      model: 'kimi-k3', messages, reasoning: { effort: 'none', enabled: false },
    })).rejects.toThrow('cannot be disabled');
    await expect(encode({
      model: 'kimi-k3', messages, reasoning_effort: 'none',
    })).rejects.toThrow('cannot be disabled');
    await expect(encode({
      model: 'kimi-k3', input: 'Answer briefly.', reasoning: { effort: 'none' },
    }, true)).rejects.toThrow('cannot be disabled');
    const options: CompletionOptions = {
      providerId: provider.id,
      model: 'kimi-k3',
      thinkLevel: 'none',
      messages: [{ id: 'user-1', role: 'user', content: 'Answer briefly.', timestamp: 1 }],
    };
    await expect(callOpenAICompletion(provider, 'test-key', options, logger))
      .rejects.toThrow('cannot be disabled');
    await expect(streamOpenAICompletion(provider, 'test-key', options, 'stream-off', {}, logger))
      .rejects.toThrow('cannot be disabled');
    const responses = { ...provider, apiFormat: 'openai-response' as const };
    await expect(callOpenAIResponseCompletion(responses, 'test-key', options, logger))
      .rejects.toThrow('cannot be disabled');
    await expect(streamOpenAIResponseCompletion(responses, 'test-key', options, 'stream-off', {}, logger))
      .rejects.toThrow('cannot be disabled');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['kimi-k3', undefined],
    ['kimi-k2-thinking', 'none'],
  ] as const)(
    'preserves mandatory reasoning and tool continuation for %s with Responses effort %s',
    async (model, effort) => {
      const body = await encode({
        model,
        ...(effort === undefined ? {} : { reasoning: { effort } }),
        input: [
          { type: 'message', role: 'user', content: 'Read the file.' },
          {
            type: 'reasoning',
            id: 'reasoning-1',
            summary: [{ type: 'summary_text', text: 'I need the file contents first.' }],
          },
          { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' },
          { type: 'function_call_output', call_id: 'call-1', output: 'file contents' },
        ],
      }, true);

      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body).not.toHaveProperty('thinking');
      expect(body).not.toHaveProperty('reasoning');
      expect(body.messages).toEqual([
        expect.objectContaining({ role: 'user', content: 'Read the file.' }),
        expect.objectContaining({
          role: 'assistant',
          reasoning_content: 'I need the file contents first.',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
          }],
        }),
        expect.objectContaining({ role: 'tool', tool_call_id: 'call-1', content: 'file contents' }),
      ]);
    },
  );
});

describe('Canonical legacy Kimi reasoning wire policy', () => {
  it.each([
    ['kimi-k2.5', 'none', 'disabled'],
    ['kimi-k2.5', 'high', 'enabled'],
    ['kimi-k2.6', 'none', 'disabled'],
    ['kimi-k2.6', 'high', 'enabled'],
    ['kimi-k2-thinking', 'none', undefined],
    ['kimi-k2-thinking', 'high', undefined],
  ] as const)(
    'encodes %s %s without unsupported native effort',
    async (model, thinkLevel, toggle) => {
      const unified = await encode({
        model,
        messages: [{ role: 'user', content: 'Answer briefly.' }],
        reasoning: { effort: thinkLevel, enabled: thinkLevel !== 'none' },
      });
      const options: CompletionOptions = {
        providerId: provider.id,
        model,
        thinkLevel,
        messages: [{ id: 'user-1', role: 'user', content: 'Answer briefly.', timestamp: 1 }],
      };
      await callOpenAICompletion(provider, 'test-key', options, logger);
      await streamOpenAICompletion(provider, 'test-key', options, 'stream-legacy', {}, logger);

      expect(bodies).toHaveLength(2);
      for (const body of [unified, ...bodies]) {
        expect(body).not.toHaveProperty('reasoning_effort');
        expect(body).not.toHaveProperty('reasoning');
        if (toggle) {
          expect(body.thinking).toEqual({ type: toggle });
        } else {
          expect(body).not.toHaveProperty('thinking');
        }
      }
    },
  );
});

describe('Canonical Kimi native Chat off negotiation', () => {
  it.each([
    ['kimi-k2.5', 'disabled'],
    ['kimi-k2.6', 'disabled'],
  ] as const)('negotiates native none for %s without a unified reasoning object', async (model, toggle) => {
    const body = await encode({
      model,
      messages: [{ role: 'user', content: 'Answer briefly.' }],
      reasoning_effort: 'none',
    });

    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('reasoning');
    if (toggle) {
      expect(body.thinking).toEqual({ type: toggle });
    } else {
      expect(body).not.toHaveProperty('thinking');
    }
  });
});
