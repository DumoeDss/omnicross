import type { LLMProvider } from '@omnicross/contracts/llm-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../ports/logger';
import {
  callAnthropicCompletion,
  callGeminiCompletion,
  callOpenAICompletion,
  callOpenAIResponseCompletion,
} from '../DirectApiHandler';
import {
  streamAnthropicCompletion,
  streamGeminiCompletion,
  streamOpenAICompletion,
  streamOpenAIResponseCompletion,
} from '../StreamHandler';
import type { CompletionOptions } from '../types';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const callbacks = { onError: vi.fn() };
let bodies: Array<Record<string, any>> = [];

function provider(
  apiFormat: LLMProvider['apiFormat'],
  model: string,
  modelConfigs?: LLMProvider['modelConfigs'],
): LLMProvider {
  return {
    id: `provider-${apiFormat}`,
    name: `Provider ${apiFormat}`,
    apiFormat,
    api_base_url: 'https://example.test/v1',
    api_key: 'secret',
    models: [model],
    modelConfigs,
    enabled: true,
  };
}

function options(
  model: string,
  thinkLevel: CompletionOptions['thinkLevel'],
  overrides: Partial<CompletionOptions> = {},
): CompletionOptions {
  return {
    providerId: 'provider',
    model,
    thinkLevel,
    messages: [{
      id: 'user-1',
      role: 'user',
      content: 'hello',
      timestamp: 1,
    }],
    ...overrides,
  };
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

describe('Completion OpenAI reasoning wire bodies', () => {
  it('preserves GPT-5.6 max in direct and streaming Chat requests', async () => {
    const openai = provider('openai', 'gpt-5.6');
    const requestOptions = options('gpt-5.6', 'max');

    await callOpenAICompletion(openai, 'key', requestOptions, logger);
    await streamOpenAICompletion(
      openai,
      'key',
      requestOptions,
      'message-1',
      callbacks,
      logger,
    );

    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['max', 'max']);
  });

  it('preserves GPT-5.6 max in direct and streaming Responses requests', async () => {
    const responses = provider('openai-response', 'gpt-5.6');
    const requestOptions = options('gpt-5.6', 'max');

    await callOpenAIResponseCompletion(responses, 'key', requestOptions, logger);
    await streamOpenAIResponseCompletion(
      responses,
      'key',
      requestOptions,
      'message-1',
      callbacks,
      logger,
    );

    expect(bodies.map((body) => body.reasoning?.effort)).toEqual(['max', 'max']);
  });

  it('negotiates older models and provider overrides in both variants', async () => {
    const responses = provider('openai-response', 'gpt-5.3-codex');
    const olderOptions = options('gpt-5.3-codex', 'max');
    await callOpenAIResponseCompletion(responses, 'key', olderOptions, logger);

    const overridden = provider('openai', 'gpt-5.6', [{
      id: 'gpt-5.6',
      name: 'GPT override',
      enabled: true,
      thinkingLevels: ['low', 'high'],
    }]);
    const overriddenOptions = options('gpt-5.6', 'max');
    await callOpenAICompletion(overridden, 'key', overriddenOptions, logger);
    await streamOpenAICompletion(
      overridden,
      'key',
      overriddenOptions,
      'message-1',
      callbacks,
      logger,
    );

    expect(bodies[0].reasoning.effort).toBe('xhigh');
    expect(bodies.slice(1).map((body) => body.reasoning_effort)).toEqual(['high', 'high']);
  });

  it('does not enable missing or disabled intent', async () => {
    const openai = provider('openai', 'gpt-5.6');
    await callOpenAICompletion(openai, 'key', options('gpt-5.6', undefined), logger);
    await callOpenAICompletion(openai, 'key', options('gpt-5.6', 'none'), logger);

    expect(bodies[0]).not.toHaveProperty('reasoning_effort');
    expect(bodies[1]).not.toHaveProperty('reasoning_effort');
  });

  it('omits enabled reasoning for a disable-only provider override', async () => {
    const openai = provider('openai', 'disable-only', [{
      id: 'disable-only',
      name: 'Disable only',
      enabled: true,
      thinkingLevels: ['none'],
    }]);
    const requestOptions = options('disable-only', 'high');

    await callOpenAICompletion(openai, 'key', requestOptions, logger);
    await streamOpenAICompletion(
      openai,
      'key',
      requestOptions,
      'message-1',
      callbacks,
      logger,
    );

    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => !Object.hasOwn(body, 'reasoning_effort'))).toBe(true);
  });
});

describe('Completion budget reasoning wire bodies', () => {
  it('omits enabled Anthropic/Gemini wire fields for disable-only overrides', async () => {
    const anthropic = provider('anthropic', 'disable-anthropic', [{
      id: 'disable-anthropic',
      name: 'Disable Anthropic',
      enabled: true,
      thinkingLevels: ['none'],
    }]);
    const gemini = provider('google', 'disable-gemini', [{
      id: 'disable-gemini',
      name: 'Disable Gemini',
      enabled: true,
      thinkingLevels: ['none'],
    }]);

    await callAnthropicCompletion(
      anthropic,
      'key',
      options('disable-anthropic', 'high'),
      logger,
    );
    await streamAnthropicCompletion(
      anthropic,
      'key',
      options('disable-anthropic', 'high'),
      'message-anthropic',
      callbacks,
      logger,
    );
    await callGeminiCompletion(gemini, 'key', options('disable-gemini', 'high'), logger);
    await streamGeminiCompletion(
      gemini,
      'key',
      options('disable-gemini', 'high'),
      'message-gemini',
      callbacks,
      logger,
    );

    expect(bodies.slice(0, 2).every((body) =>
      !Object.hasOwn(body, 'thinking') && !Object.hasOwn(body, 'output_config')
    )).toBe(true);
    expect(bodies.slice(2).every((body) =>
      !Object.hasOwn(body.generationConfig, 'thinkingConfig')
    )).toBe(true);
  });

  it('encodes adaptive Anthropic effort equivalently', async () => {
    const anthropic = provider('anthropic', 'claude-opus-4-6');
    const requestOptions = options('claude-opus-4-6', 'minimal');

    await callAnthropicCompletion(anthropic, 'key', requestOptions, logger);
    await streamAnthropicCompletion(
      anthropic,
      'key',
      requestOptions,
      'message-1',
      callbacks,
      logger,
    );

    expect(bodies.map((body) => body.thinking)).toEqual([
      { type: 'adaptive' },
      { type: 'adaptive' },
    ]);
    expect(bodies.map((body) => body.output_config)).toEqual([
      { effort: 'low' },
      { effort: 'low' },
    ]);
  });

  it('keeps legacy Anthropic direct/stream × text/image budgets bounded with output headroom', async () => {
    const anthropic = provider('anthropic', 'legacy-claude', [{
      id: 'legacy-claude',
      name: 'Legacy Claude',
      enabled: true,
      thinkingLevels: [],
      thinkingTokenLimit: { min: 1024, max: 4096 },
    }]);
    const textOptions = options('legacy-claude', 'high', {
      maxTokens: 3000,
      temperature: 0.2,
    });
    const imageOptions = options('legacy-claude', 'high', {
      maxTokens: 3000,
      temperature: 0.2,
      messages: [{
        id: 'user-image',
        role: 'user',
        content: 'describe',
        images: [{ url: 'data:image/png;base64,AAAA', mimeType: 'image/png' }],
        timestamp: 1,
      }],
    });

    await callAnthropicCompletion(anthropic, 'key', textOptions, logger);
    await callAnthropicCompletion(anthropic, 'key', imageOptions, logger);
    await streamAnthropicCompletion(
      anthropic,
      'key',
      textOptions,
      'message-text',
      callbacks,
      logger,
    );
    await streamAnthropicCompletion(
      anthropic,
      'key',
      imageOptions,
      'message-1',
      callbacks,
      logger,
    );

    expect(bodies).toHaveLength(4);
    expect(bodies.map((body) => body.thinking)).toEqual(
      Array.from({ length: 4 }, () => ({ type: 'enabled', budget_tokens: 2250 })),
    );
    expect(bodies.map((body) => body.max_tokens)).toEqual([3000, 3000, 3000, 3000]);
    expect(bodies.every((body) => body.max_tokens - body.thinking.budget_tokens >= 750)).toBe(true);
    expect(bodies.every((body) => !Object.hasOwn(body, 'temperature'))).toBe(true);
  });

  it.each([
    ['low', 1024],
    ['medium', 8000],
    ['high', 12000],
  ] as const)('serializes effort-aware legacy Anthropic %s budgets in direct and stream requests', async (
    effort,
    expectedBudget,
  ) => {
    const anthropic = provider('anthropic', 'legacy-claude-effort-aware', [{
      id: 'legacy-claude-effort-aware',
      name: 'Legacy Claude Effort Aware',
      enabled: true,
      thinkingLevels: [],
      thinkingTokenLimit: { min: 1024, max: 64000 },
    }]);
    const requestOptions = options('legacy-claude-effort-aware', effort, {
      maxTokens: 16000,
    });

    await callAnthropicCompletion(anthropic, 'key', requestOptions, logger);
    await streamAnthropicCompletion(
      anthropic,
      'key',
      requestOptions,
      `message-${effort}`,
      callbacks,
      logger,
    );

    expect(bodies).toHaveLength(2);
    expect(bodies.map((body) => body.thinking)).toEqual([
      { type: 'enabled', budget_tokens: expectedBudget },
      { type: 'enabled', budget_tokens: expectedBudget },
    ]);
    expect(bodies.map((body) => body.max_tokens)).toEqual([16000, 16000]);
  });

  it('keeps legacy Gemini budgets bounded and equivalent', async () => {
    const gemini = provider('google', 'legacy-gemini', [{
      id: 'legacy-gemini',
      name: 'Legacy Gemini',
      enabled: true,
      thinkingLevels: [],
      thinkingTokenLimit: { min: 100, max: 1000 },
    }]);
    const requestOptions = options('legacy-gemini', 'high', { maxTokens: 500 });

    await callGeminiCompletion(gemini, 'key', requestOptions, logger);
    await streamGeminiCompletion(
      gemini,
      'key',
      requestOptions,
      'message-1',
      callbacks,
      logger,
    );

    expect(bodies.map((body) => body.generationConfig.thinkingConfig)).toEqual([
      { includeThoughts: true, thinkingBudget: 500 },
      { includeThoughts: true, thinkingBudget: 500 },
    ]);
  });

  it('encodes Gemini direct/stream × enabled/disabled equivalently', async () => {
    const gemini = provider('google', 'gemini-3-flash');
    const enabledOptions = options('gemini-3-flash', 'xhigh');
    const disabledOptions = options('gemini-3-flash', 'none');

    await callGeminiCompletion(gemini, 'key', enabledOptions, logger);
    await callGeminiCompletion(gemini, 'key', disabledOptions, logger);
    await streamGeminiCompletion(
      gemini,
      'key',
      enabledOptions,
      'message-enabled',
      callbacks,
      logger,
    );
    await streamGeminiCompletion(
      gemini,
      'key',
      disabledOptions,
      'message-disabled',
      callbacks,
      logger,
    );

    expect(bodies.map((body) => body.generationConfig.thinkingConfig)).toEqual([
      { includeThoughts: true, thinkingLevel: 'high' },
      { includeThoughts: false, thinkingLevel: 'none' },
      { includeThoughts: true, thinkingLevel: 'high' },
      { includeThoughts: false, thinkingLevel: 'none' },
    ]);
  });
});
