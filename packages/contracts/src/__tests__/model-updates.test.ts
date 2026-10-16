import { describe, expect, it } from 'vitest';

import { KNOWN_MODELS } from '../canonical-models';
import type { LLMProvider } from '../llm-config';
import { LLM_PROVIDER_PRESETS, PROVIDER_MODEL_MAPPINGS, refreshOfficialTextModels, resolveOfficialModelRoute, resolveRetiredOfficialModel } from '../provider-presets';

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
});
