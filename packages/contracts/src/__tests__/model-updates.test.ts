import { describe, expect, it } from 'vitest';

import { applyAlias, KNOWN_MODELS, lookupCanonicalCapabilities, resolveModelRedirect } from '../canonical-models';
import type { LLMProvider } from '../llm-config';
import { LLM_PROVIDER_PRESETS, PROVIDER_MODEL_MAPPINGS, refreshOfficialTextModels, resolveOfficialModelRoute, resolveRetiredOfficialModel } from '../provider-presets';
import { calculateThinkingBudget, canDisableThinking, isReasoningModel } from '../thinking-config';

describe('current official model catalogs', () => {
  it('recommends MiMo 2.6 and Gemini 4 with separate image models', () => {
    for (const id of ['xiaomi-mimo', 'xiaomi-mimo-anthropic']) {
      const preset = LLM_PROVIDER_PRESETS.find((row) => row.id === id)!;
      expect(preset.models).toContain('mimo-v2.6-pro-ultraspeed');
      expect(preset.models).not.toContain('mimo-v2.5');
    }
    expect(PROVIDER_MODEL_MAPPINGS['xiaomi-mimo'].primary).toBe('mimo-v2.6-pro');
    expect(KNOWN_MODELS['gemini-4-argon']).toMatchObject({ contextLength: 1048576, maxTokens: 65536, thinkingLevels: ['low', 'medium', 'high'] });
    expect(LLM_PROVIDER_PRESETS.find((row) => row.id === 'gemini')?.models).toContain('gemini-4-argon');
  });

  it('redirects retired DeepSeek names to Flash and uses its tool and thinking capabilities', () => {
    for (const id of ['deepseek-chat', 'deepseek-reasoner']) {
      expect(resolveModelRedirect(id)).toBe('deepseek-flash');
      expect(applyAlias(id)).toBe('deepseek-flash');
      expect(lookupCanonicalCapabilities(id)).toMatchObject({
        functionCall: true,
        reasoning: true,
        thinkingLevels: ['none', 'low', 'high', 'max'],
      });
      expect(canDisableThinking(id)).toBe(true);
      expect(calculateThinkingBudget(id, 'none', 4096)).toBeUndefined();
      expect(LLM_PROVIDER_PRESETS.find((row) => row.id === 'deepseek')?.models).not.toContain(id);
    }
  });

  it('does not redirect third-party deployments or capability-only marketing aliases', () => {
    for (const id of ['deepseek-flash', 'deepseek-r1', 'deepseek-v3', 'deepseek/deepseek-chat', 'deepseek-chat:deployment', 'gpt-5.6', 'custom-model']) {
      expect(resolveModelRedirect(id)).toBe(id);
    }
  });

  it('migrates saved official MiMo catalogs and refs while preserving disabled choices and credentials', () => {
    const provider = {
      id: 'mimo', api_base_url: 'https://api.xiaomimimo.com/v1', api_key: 'test-secret',
      models: ['mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2.5-asr'],
      modelConfigs: [{ id: 'mimo-v2.5', name: 'MiMo v2.5', enabled: false }],
    } as LLMProvider;
    const updated = refreshOfficialTextModels(provider);
    expect(updated.models).toEqual(['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.5-asr']);
    expect(updated.modelConfigs?.[0]).toMatchObject({ id: 'mimo-v2.6-flash', enabled: false });
    expect(updated.api_key).toBe('test-secret');
    expect(provider.models[0]).toBe('mimo-v2.5');
    expect(refreshOfficialTextModels(updated)).toBe(updated);
    expect(resolveOfficialModelRoute(updated, 'mimo-v2.5-pro')).toMatchObject({ actualProviderId: 'mimo', actualModelId: 'mimo-v2.6-pro' });
  });

  it('uses the effective endpoint and preserves third-party, custom and speech IDs', () => {
    const row = { id: 'mimo', api_base_url: 'https://proxy.example/v1', api_key: 'key', models: ['mimo-v2.5'] } as LLMProvider;
    expect(refreshOfficialTextModels(row)).toBe(row);
    expect(resolveOfficialModelRoute(row, 'mimo-v2.5')).toBeNull();
    expect(resolveRetiredOfficialModel('mimo-v2.5-tts', 'https://api.xiaomimimo.com/v1')).toBe('mimo-v2.5-tts');
    expect(resolveRetiredOfficialModel('mimo-v2.5', 'https://api.xiaomimimo.com.evil.example')).toBe('mimo-v2.5');
    expect(resolveOfficialModelRoute({ ...row, codingPlan: { enabled: true, baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' } }, 'mimo-v2.5')?.actualModelId).toBe('mimo-v2.6-flash');
  });

  it('preserves an unknown model id even when it names an Object prototype property', () => {
    for (const id of ['constructor', '__proto__', 'toString']) {
      expect(applyAlias(id)).toBe(id);
      expect(lookupCanonicalCapabilities(id)).toBeUndefined();
      expect(resolveRetiredOfficialModel(id, 'https://api.xiaomimimo.com/v1')).toBe(id);
      expect(resolveModelRedirect(id)).toBe(id);
    }
  });

  it('resolves Copilot dotted Claude versions to the same thinking capabilities', () => {
    expect(lookupCanonicalCapabilities('anthropic/claude-opus-4.6:beta'))
      .toEqual(lookupCanonicalCapabilities('claude-opus-4-6'));
  });

  it('keeps a saved replacement row authoritative even when models only lists the retired id', () => {
    const provider = {
      id: 'mimo', api_base_url: 'https://api.xiaomimimo.com/v1', models: ['mimo-v2.5'],
      modelConfigs: [
        { id: 'mimo-v2.5', name: 'old', enabled: true },
        { id: 'mimo-v2.6-flash', name: 'custom current', enabled: false, maxTokens: 2048 },
      ],
    } as LLMProvider;
    expect(refreshOfficialTextModels(provider).modelConfigs).toEqual([provider.modelConfigs![1]]);
  });

  it('does not drop saved model settings merely because the replacement id is already listed', () => {
    const provider = {
      id: 'mimo', api_base_url: 'https://api.xiaomimimo.com/v1',
      models: ['mimo-v2.5', 'mimo-v2.6-flash'],
      modelConfigs: [{ id: 'mimo-v2.5', name: 'custom', enabled: false, maxTokens: 2048 }],
    } as LLMProvider;
    expect(refreshOfficialTextModels(provider).modelConfigs).toEqual([
      { id: 'mimo-v2.6-flash', name: 'custom', enabled: false, maxTokens: 2048 },
    ]);
  });

  it('uses declared reasoning support rather than outdated name heuristics', () => {
    expect(isReasoningModel('zai-org/GLM-5.3')).toBe(true);
    expect(isReasoningModel('Qwen/Qwen3.8-Max')).toBe(true);
    expect(isReasoningModel('MiniMax-M2.5')).toBe(true);
    expect(isReasoningModel('gemini-2.5-flash-image')).toBe(false);
    expect(isReasoningModel('claude-3-5-sonnet')).toBe(false);
    expect(isReasoningModel('unknown-provider-model')).toBe(false);
    expect(canDisableThinking('claude-opus-5-5')).toBe(false);
    expect(calculateThinkingBudget('claude-haiku-4-5', 'none', 4096)).toBeUndefined();
  });
});
