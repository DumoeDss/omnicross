import type { ThinkLevel } from '@omnicross/contracts/completion-types';
import type { LLMProvider } from '@omnicross/contracts/llm-config';
import { getPresetById } from '@omnicross/contracts/provider-presets';
import { describe, expect, it } from 'vitest';

import type { StreamWithToolsOptions } from '../ToolHandler';
import { buildToolRequest } from '../ToolExecutor';

function request(
  presetId: string,
  model: string,
  thinkLevel: ThinkLevel,
  apiFormat: 'openai' | 'openai-response' = 'openai',
): Record<string, unknown> {
  const preset = getPresetById(presetId);
  if (!preset) throw new Error(`Missing canonical preset: ${presetId}`);
  const provider: LLMProvider = { ...preset, enabled: true, api_key: 'test-key', apiFormat };
  const options: StreamWithToolsOptions = {
    providerId: provider.id,
    model,
    thinkLevel,
    messages: [{ id: 'user-1', role: 'user', content: 'Continue the task.', timestamp: 1 }],
    tools: [],
  };
  return JSON.parse(JSON.stringify(
    buildToolRequest(apiFormat, options.messages, model, options, provider).requestBody,
  ));
}

describe('tool-loop reasoning controls', () => {
  it.each([
    ['deepseek', 'deepseek-flash', 'none', 'disabled'],
    ['kimi', 'kimi-k2.6', 'none', 'disabled'],
    ['kimi', 'kimi-k2.6', 'high', 'enabled'],
  ] as const)('uses %s native toggle for %s at %s', (presetId, model, level, type) => {
    const body = request(presetId, model, level);
    expect(body.thinking).toMatchObject({ type });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('keeps supported OpenAI Chat off as effort rather than a foreign toggle', () => {
    const body = request('openai', 'gpt-5.1', 'none');
    expect(body.reasoning_effort).toBe('none');
    expect(body).not.toHaveProperty('thinking');
  });

  it('does not request reasoning summaries while Responses thinking is disabled', () => {
    const body = request('deepseek', 'deepseek-flash', 'none', 'openai-response');
    expect(body.reasoning).toEqual({ effort: 'none' });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('rejects unsupported Kimi K3 off before constructing a tool request', () => {
    expect(() => request('kimi', 'kimi-k3', 'none')).toThrow();
  });
});
