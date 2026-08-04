import type { LLMProvider } from '@omnicross/contracts/llm-config';
import { describe, expect, it } from 'vitest';

import { buildRequestBody as buildGeminiRequestBody } from '../../transformer/transformers/utils/gemini.util';
import { buildToolRequest } from '../ToolExecutor';
import { buildUnifiedCompletionRequest } from '../TransformerHandler';
import type { CompletionOptions } from '../types';
import type { StreamWithToolsOptions } from '../ToolHandler';

const provider = {
  id: 'provider',
  name: 'Provider',
  enabled: true,
  api_key: 'secret',
  api_base_url: 'https://api.example.com/v1/chat/completions',
  models: ['model-a'],
} as unknown as LLMProvider;

function makeOptions(maxTokens?: number): CompletionOptions {
  return {
    providerId: provider.id,
    model: 'model-a',
    messages: [{ id: 'user-1', role: 'user', content: 'hello', timestamp: 1 }],
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

function makeToolOptions(maxTokens?: number): StreamWithToolsOptions {
  return {
    ...makeOptions(maxTokens),
    tools: [],
  };
}

describe('output-token wire semantics', () => {
  it('keeps max_tokens absent in the transformer path when no cap was configured', () => {
    const request = buildUnifiedCompletionRequest('model-a', makeOptions(), false);
    const gemini = buildGeminiRequestBody(request);

    expect(request).not.toHaveProperty('max_tokens');
    expect(gemini.generationConfig).toBeUndefined();
  });

  it('preserves an explicit cap through unified and Gemini request conversion', () => {
    const unified = buildUnifiedCompletionRequest('model-a', makeOptions(384_000), false);
    const gemini = buildGeminiRequestBody(unified);

    expect(unified.max_tokens).toBe(384_000);
    expect(gemini.generationConfig?.maxOutputTokens).toBe(384_000);
  });

  it('omits optional output caps from OpenAI and Gemini tool requests', () => {
    const messages = makeOptions().messages;
    const openai = buildToolRequest('openai', messages, 'model-a', makeToolOptions(), provider);
    const gemini = buildToolRequest('google', messages, 'model-a', makeToolOptions(), provider);

    expect(openai.requestBody).not.toHaveProperty('max_tokens');
    expect(gemini.requestBody).not.toHaveProperty('generationConfig');
  });

  it('supplies a fallback only for the native Anthropic tool protocol', () => {
    const messages = makeOptions().messages;
    const anthropic = buildToolRequest(
      'anthropic',
      messages,
      'claude-sonnet-4-6',
      makeToolOptions(),
      provider,
    );

    expect(anthropic.requestBody.max_tokens).toEqual(expect.any(Number));
    expect(anthropic.requestBody.max_tokens).toBeGreaterThan(0);
  });
});
