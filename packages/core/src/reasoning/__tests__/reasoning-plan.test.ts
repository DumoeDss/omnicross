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
    expect(resolveReasoningPlan({
      intent: { effort: 'none', enabled: false },
      model: 'gpt-5.3-codex',
      target: 'openai-chat',
    })).toEqual({ kind: 'off' });
  });

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
    expect(resolveReasoningPlan({
      intent: { effort: 'none', enabled: false },
      model: 'gemini-3-flash',
      target: 'gemini',
    })).toEqual({ kind: 'level', effort: 'none', enabled: false });

    expect(resolveReasoningPlan({
      intent: { effort: 'none', enabled: false },
      model: 'legacy-gemini-flash',
      provider: { modelConfigs: [{ id: 'legacy-gemini-flash', thinkingLevels: [] }] },
      target: 'gemini',
    })).toEqual({ kind: 'budget', effort: 'none', enabled: false, budgetTokens: 0 });
  });
});
