import { findTokenLimit } from '@omnicross/contracts/thinking-config';
import { describe, expect, it } from 'vitest';

import {
  resolveReasoningEffort,
  resolveReasoningPlan,
  resolveReasoningTokenLimit,
} from '../reasoning-plan';

const enabled = (effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max') => ({
  effort,
  enabled: true,
} as const);

describe('resolveReasoningPlan discrete effort', () => {
  it('preserves GPT-5.6 max and negotiates older models conservatively', () => {
    expect(resolveReasoningPlan({
      intent: enabled('max'),
      model: 'gpt-5.6',
      target: 'openai-responses',
    })).toEqual({ kind: 'level', effort: 'max', enabled: true });

    expect(resolveReasoningPlan({
      intent: enabled('max'),
      model: 'gpt-5.3-codex',
      target: 'openai-responses',
    })).toEqual({ kind: 'level', effort: 'xhigh', enabled: true });

    expect(resolveReasoningPlan({
      intent: enabled('max'),
      model: 'o3',
      target: 'openai-chat',
    })).toEqual({ kind: 'level', effort: 'high', enabled: true });
  });

  it.each(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'])(
    'preserves the supported low effort for %s rather than escalating to high', (model) => {
      expect(resolveReasoningPlan({
        intent: enabled('low'), model, target: 'openai-chat',
      })).toEqual({ kind: 'level', effort: 'low', enabled: true });
    },
  );

  it.each([
    ['minimal', 'low'], ['low', 'low'], ['medium', 'high'],
    ['high', 'high'], ['xhigh', 'high'], ['max', 'max'],
  ] as const)('uses the official DeepSeek %s to %s mapping on both OpenAI wires', (requested, expected) => {
    for (const target of ['openai-chat', 'openai-responses'] as const) {
      expect(resolveReasoningPlan({
        intent: enabled(requested), model: 'deepseek-v4-pro', target,
        provider: { baseUrl: 'https://api.deepseek.com/v1' },
      })).toEqual({ kind: 'level', effort: expected, enabled: true });
    }
  });

  it('does not impose the official DeepSeek mapping on unknown or aggregator endpoints', () => {
    expect(resolveReasoningPlan({
      intent: enabled('xhigh'), model: 'deepseek-v4-pro', target: 'openai-chat',
      provider: { baseUrl: 'https://aggregator.example/v1' },
    })).toEqual({ kind: 'level', effort: 'max', enabled: true });
  });

  it('handles sparse levels, lower ties, and provider overrides', () => {
    expect(resolveReasoningPlan({
      intent: enabled('medium'),
      model: 'sparse',
      provider: { modelConfigs: [{ id: 'sparse', thinkingLevels: ['low', 'max'] }] },
      target: 'openai-chat',
    })).toEqual({ kind: 'level', effort: 'low', enabled: true });

    expect(resolveReasoningPlan({
      intent: enabled('xhigh'),
      model: 'gpt-5.3-codex',
      provider: {
        modelConfigs: [{ id: 'gpt-5.3-codex', thinkingLevels: ['low', 'high'] }],
      },
      target: 'openai-chat',
    })).toEqual({ kind: 'level', effort: 'high', enabled: true });
  });

  it('preserves native same-format effort and recognized unknown effort', () => {
    expect(resolveReasoningPlan({
      intent: enabled('max'),
      model: 'custom',
      provider: { modelConfigs: [{ id: 'custom', thinkingLevels: ['low', 'high'] }] },
      target: 'openai-responses',
      preserveNativeEffort: true,
    })).toEqual({ kind: 'level', effort: 'max', enabled: true });

    expect(resolveReasoningPlan({
      intent: enabled('xhigh'),
      model: 'missing-model',
      target: 'openai-chat',
    })).toEqual({ kind: 'level', effort: 'xhigh', enabled: true });
  });

  it('does not create a plan for missing intent or promote disabled intent', () => {
    expect(resolveReasoningPlan({
      model: 'gpt-5.6',
      target: 'openai-chat',
    })).toBeUndefined();
    expect(() => resolveReasoningPlan({
      intent: { effort: 'none', enabled: false },
      model: 'gpt-5.3-codex',
      target: 'openai-chat',
    })).toThrow('cannot be disabled');
  });

  it.each(['kimi-k3', 'grok-4.5', 'grok-4.3'])(
    'rejects explicit off for %s before native preservation or wire omission',
    (model) => {
      for (const target of ['openai-chat', 'openai-responses'] as const) {
        expect(() => resolveReasoningPlan({
          intent: { effort: 'none', enabled: false },
          model,
          provider: { name: model.startsWith('kimi') ? 'Kimi' : 'Grok' },
          target,
          preserveNativeEffort: true,
        })).toThrow('cannot be disabled');
      }
      expect(resolveReasoningPlan({ model, target: 'openai-chat' })).toBeUndefined();
    },
  );

  it.each(['openai-chat', 'openai-responses'] as const)(
    'keeps explicit disable-only catalogs as an omission marker on %s',
    (target) => {
      expect(resolveReasoningPlan({
        intent: { effort: 'none', enabled: false },
        model: 'disable-only',
        provider: { modelConfigs: [{ id: 'disable-only', thinkingLevels: ['none'] }] },
        target,
        preserveNativeEffort: true,
      })).toEqual({ kind: 'off' });
    },
  );

  it.each([
    'openai-chat',
    'openai-responses',
    'anthropic',
    'gemini',
  ] as const)('treats a non-empty disable-only override as off for %s', (target) => {
    const provider = {
      modelConfigs: [{ id: 'disable-only', thinkingLevels: ['none' as const] }],
    };

    expect(resolveReasoningEffort('high', 'disable-only', provider)).toBe('none');
    expect(resolveReasoningPlan({
      intent: enabled('high'),
      model: 'disable-only',
      provider,
      target,
      preserveNativeEffort: true,
    })).toEqual({ kind: 'off' });
  });
});

describe('resolveReasoningPlan token budgets', () => {
  it.each([
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'models/gemini-2.5-flash',
    'google/gemini-2.5-flash-lite:beta',
    'gemini-2.5-flash-preview-05-20',
  ])('uses numeric Gemini budgets for %s despite effort presets', (model) => {
    expect(resolveReasoningPlan({
      intent: enabled('high'),
      model,
      target: 'gemini',
    })).toEqual({ kind: 'budget', effort: 'high', enabled: true, budgetTokens: 19660 });

    expect(resolveReasoningPlan({
      intent: { ...enabled('high'), max_tokens: 8192 },
      model,
      target: 'gemini',
      requestMaxTokens: 4096,
    })).toMatchObject({ kind: 'budget', budgetTokens: 4096 });

    expect(resolveReasoningPlan({
      intent: { effort: 'none', enabled: false },
      model,
      target: 'gemini',
    })).toEqual({ kind: 'budget', effort: 'none', enabled: false, budgetTokens: 0 });
  });

  it('honors Gemini 2.5 provider limits and keeps OpenAI-compatible efforts discrete', () => {
    const model = 'gemini-2.5-flash';
    const provider = {
      modelConfigs: [{ id: model, thinkingTokenLimit: { min: 100, max: 1000 } }],
    };
    expect(resolveReasoningPlan({
      intent: enabled('medium'),
      model,
      provider,
      target: 'gemini',
    })).toEqual({ kind: 'budget', effort: 'medium', enabled: true, budgetTokens: 550 });
    expect(resolveReasoningPlan({
      intent: enabled('high'),
      model,
      target: 'openai-chat',
    })).toEqual({ kind: 'level', effort: 'high', enabled: true });
    expect(() => resolveReasoningPlan({
      intent: { effort: 'none', enabled: false },
      model: 'gemini-2.5-pro',
      target: 'gemini',
    })).toThrow('cannot be disabled');
  });

  it.each([
    ['gemini-3-flash', 'high'],
    ['gemini-3.1-pro', 'high'],
    ['gemini-4-argon', 'low'],
    ['gemini-4-argon', 'medium'],
    ['gemini-4-argon', 'high'],
    ['models/gemini-4-argon', 'high'],
  ] as const)('keeps %s on native %s thinking levels', (model, effort) => {
    expect(resolveReasoningPlan({
      intent: { ...enabled(effort), max_tokens: 8192 },
      model,
      target: 'gemini',
    })).toEqual({ kind: 'level', effort, enabled: true });
  });

  it('uses provider then canonical token limits before compatibility fallbacks', () => {
    expect(resolveReasoningTokenLimit('gpt-5.6', undefined, 'gemini')).toEqual({
      min: 0,
      max: 128000,
    });
    expect(findTokenLimit('gpt-5.6')).toEqual({ min: 0, max: 128000 });

    expect(resolveReasoningTokenLimit('gpt-5.6', {
      modelConfigs: [{ id: 'gpt-5.6-sol', thinkingTokenLimit: { min: 10, max: 900 } }],
    }, 'gemini')).toEqual({ min: 10, max: 900 });

    expect(resolveReasoningTokenLimit(
      'claude-opus-4.7-legacy-deployment',
      undefined,
      'anthropic',
    )).toEqual({ min: 1024, max: 128000 });
  });

  it('treats an explicit empty level override as legacy budget mode', () => {
    expect(resolveReasoningPlan({
      intent: { ...enabled('high'), max_tokens: 6000 },
      model: 'claude-opus-4-6',
      provider: {
        modelConfigs: [{
          id: 'claude-opus-4-6',
          thinkingLevels: [],
          thinkingTokenLimit: { min: 1024, max: 4096 },
        }],
      },
      target: 'anthropic',
    })).toEqual({
      kind: 'budget',
      effort: 'high',
      enabled: true,
      budgetTokens: 4096,
    });
  });

  it('applies protocol fallbacks and Anthropic minimums for missing metadata', () => {
    expect(resolveReasoningPlan({
      intent: enabled('high'),
      model: 'unknown-claude-compatible',
      target: 'anthropic',
    })).toEqual({
      kind: 'budget',
      effort: 'high',
      enabled: true,
      budgetTokens: 32768,
    });

    expect(resolveReasoningPlan({
      intent: { ...enabled('minimal'), max_tokens: 1 },
      model: 'unknown-claude-compatible',
      target: 'anthropic',
    })).toEqual({
      kind: 'budget',
      effort: 'minimal',
      enabled: true,
      budgetTokens: 1024,
    });
  });

  it('reserves Anthropic output for automatic budgets but honors explicit budgets', () => {
    const provider = {
      modelConfigs: [{
        id: 'legacy-claude',
        thinkingLevels: [],
        thinkingTokenLimit: { min: 1024, max: 4096 },
      }],
    };

    expect(resolveReasoningPlan({
      intent: enabled('high'),
      model: 'legacy-claude',
      provider,
      target: 'anthropic',
      requestMaxTokens: 3000,
    })).toMatchObject({ kind: 'budget', budgetTokens: 2250 });
    expect(resolveReasoningPlan({
      intent: { ...enabled('high'), max_tokens: 2999 },
      model: 'legacy-claude',
      provider,
      target: 'anthropic',
      requestMaxTokens: 3000,
    })).toMatchObject({ kind: 'budget', budgetTokens: 2999 });
  });

  it.each([
    ['low', 1024],
    ['medium', 8000],
    ['high', 12000],
  ] as const)('preserves the %s effort ceiling for automatic Anthropic budgets', (
    effort,
    expectedBudget,
  ) => {
    expect(resolveReasoningPlan({
      intent: enabled(effort),
      model: 'legacy-claude-effort-aware',
      provider: {
        modelConfigs: [{
          id: 'legacy-claude-effort-aware',
          thinkingLevels: [],
          thinkingTokenLimit: { min: 1024, max: 64000 },
        }],
      },
      target: 'anthropic',
      requestMaxTokens: 16000,
    })).toMatchObject({ kind: 'budget', effort, budgetTokens: expectedBudget });
  });

  it('clamps Gemini computed, explicit, and request-bounded budgets', () => {
    const provider = {
      modelConfigs: [{
        id: 'legacy-gemini',
        thinkingLevels: [],
        thinkingTokenLimit: { min: 100, max: 1000 },
      }],
    };

    expect(resolveReasoningPlan({
      intent: enabled('medium'),
      model: 'legacy-gemini',
      provider,
      target: 'gemini',
    })).toMatchObject({ kind: 'budget', budgetTokens: 550 });
    expect(resolveReasoningPlan({
      intent: { ...enabled('high'), max_tokens: 9000 },
      model: 'legacy-gemini',
      provider,
      target: 'gemini',
    })).toMatchObject({ kind: 'budget', budgetTokens: 1000 });
    expect(resolveReasoningPlan({
      intent: enabled('high'),
      model: 'legacy-gemini',
      provider,
      target: 'gemini',
      requestMaxTokens: 400,
    })).toMatchObject({ kind: 'budget', budgetTokens: 400 });
    expect(resolveReasoningPlan({
      intent: { ...enabled('high'), max_tokens: 0 },
      model: 'legacy-gemini',
      provider,
      target: 'gemini',
    })).toMatchObject({ kind: 'budget', budgetTokens: 100 });
  });

  it('uses supported native disabled encodings without positive promotion', () => {
    expect(() => resolveReasoningPlan({
      intent: { effort: 'none', enabled: false },
      model: 'gemini-3-flash',
      target: 'gemini',
    })).toThrow('cannot be disabled');

    expect(resolveReasoningPlan({
      intent: { effort: 'none', enabled: false },
      model: 'legacy-gemini-flash',
      provider: { modelConfigs: [{ id: 'legacy-gemini-flash', thinkingLevels: [] }] },
      target: 'gemini',
    })).toEqual({ kind: 'budget', effort: 'none', enabled: false, budgetTokens: 0 });
  });

  it('rejects Gemini off when native levels or known reasoning have no legal off control', () => {
    expect(() => resolveReasoningPlan({
      intent: { effort: 'none', enabled: false },
      model: 'native-gemini',
      provider: { modelConfigs: [{
        id: 'native-gemini', thinkingLevels: ['none', 'high'], reasoning: true,
      }] },
      target: 'gemini',
    })).toThrow('cannot be disabled');
    expect(() => resolveReasoningPlan({
      intent: { effort: 'none', enabled: false },
      model: 'unknown-reasoning-gemini',
      provider: { modelConfigs: [{
        id: 'unknown-reasoning-gemini',
        reasoning: true,
        thinkingTokenLimit: { min: 128, max: 1024 },
      }] },
      target: 'gemini',
    })).toThrow('cannot be disabled');
  });

  it('does not apply an enabled Anthropic minimum budget to explicit legacy off', () => {
    expect(resolveReasoningPlan({
      intent: { effort: 'none', enabled: false },
      model: 'claude-haiku-4-5',
      target: 'anthropic',
      requestMaxTokens: 1,
    })).toEqual({ kind: 'budget', effort: 'none', enabled: false, budgetTokens: 0 });
    expect(resolveReasoningPlan({
      intent: { effort: 'none', enabled: false },
      model: 'claude-opus-4-6',
      target: 'anthropic',
      requestMaxTokens: 1,
    })).toEqual({ kind: 'level', effort: 'none', enabled: false });
  });

  it.each([1, 1023, 1024])('rejects Anthropic max_tokens=%s rather than sending an invalid budget', (requestMaxTokens) => {
    expect(() => resolveReasoningPlan({
      intent: enabled('low'),
      model: 'claude-haiku-4-5',
      target: 'anthropic',
      requestMaxTokens,
    })).toThrow('minimum thinking budget');
  });

  it('reserves final output at the smallest valid Anthropic bound', () => {
    expect(resolveReasoningPlan({
      intent: enabled('low'),
      model: 'claude-haiku-4-5',
      target: 'anthropic',
      requestMaxTokens: 1025,
    })).toMatchObject({ kind: 'budget', budgetTokens: 1024 });
  });

  it.each(['kimi-k2.5', 'mimo-v2.5-pro', 'claude-haiku-4-5'])(
    'does not infer Anthropic adaptive support from %s effort presets', (model) => {
      expect(resolveReasoningPlan({
        intent: enabled('high'),
        model,
        target: 'anthropic',
        requestMaxTokens: 16000,
      })).toMatchObject({ kind: 'budget', budgetTokens: 12000 });
    },
  );

  it.each(['claude-opus-4-7', 'claude-opus-4.8', 'claude-sonnet-5', 'claude-fable-5-1'])(
    'uses adaptive thinking for %s instead of rejected manual budgets', (model) => {
      expect(resolveReasoningPlan({
        intent: enabled('high'),
        model,
        target: 'anthropic',
      })).toEqual({ kind: 'level', effort: 'high', enabled: true });
    },
  );

  it('uses the exact provider row before a normalized sibling deployment', () => {
    expect(resolveReasoningPlan({
      intent: enabled('high'),
      model: 'vendor-b/gpt-5.6-sol',
      provider: { modelConfigs: [
        { id: 'vendor-a/gpt-5.6-sol', thinkingLevels: ['low'] },
        { id: 'vendor-b/gpt-5.6-sol', thinkingLevels: ['max'] },
      ] },
      target: 'openai-chat',
    })).toEqual({ kind: 'level', effort: 'max', enabled: true });
  });

  it.each(['gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite'])(
    'uses native levels for %s instead of legacy thinkingBudget', (model) => {
      expect(resolveReasoningPlan({
        intent: enabled('high'), model, target: 'gemini',
      })).toEqual({ kind: 'level', effort: 'high', enabled: true });
    },
  );

  it('honors an explicit non-reasoning capability instead of applying a name heuristic', () => {
    expect(() => resolveReasoningPlan({
      intent: enabled('high'),
      model: 'gemini-2.5-flash-image',
      target: 'gemini',
    })).toThrow('not supported');
  });

  it.each(['glm-5.3', 'glm-5.3-flash', 'MiniMax-M2.5', 'claude-opus-5-5'])(
    'rejects disabling the mandatory thinking in %s', (model) => {
      expect(() => resolveReasoningPlan({
        intent: { effort: 'none', enabled: false }, model, target: 'openai-chat',
      })).toThrow('cannot be disabled');
    },
  );

  it.each(['MiniMax-M3', 'MiniMax-M2.5'])(
    'uses adaptive rather than manual budgets for %s Anthropic requests', (model) => {
      expect(resolveReasoningPlan({
        intent: enabled('high'), model, target: 'anthropic',
      })).toEqual({ kind: 'level', effort: 'high', enabled: true });
    },
  );

  it.each(['claude-opus-4-6', 'gpt-5.6-sol', 'deepseek-v4-pro'])(
    'does not emit another protocol’s max level on a Gemini envelope for %s', (model) => {
      expect(resolveReasoningPlan({
        intent: enabled('max'), model, target: 'gemini',
      })).toEqual({ kind: 'level', effort: 'high', enabled: true });
    },
  );

  it('rejects a level set with no legal target-wire encoding', () => {
    expect(() => resolveReasoningPlan({
      intent: enabled('max'), model: 'custom', target: 'gemini',
      provider: { modelConfigs: [{ id: 'custom', thinkingLevels: ['max'] }] },
    })).toThrow('Thinking levels are not supported');
  });
});
