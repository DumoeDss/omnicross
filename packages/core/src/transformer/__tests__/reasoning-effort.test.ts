import { describe, expect, it } from 'vitest';

import type { ThinkLevel } from '../types';
import {
  extractReasoningIntent,
  resolveReasoningEffort,
  THINK_LEVELS,
} from '../reasoning-effort';

describe('reasoning effort intent extraction', () => {
  it('normalizes every native OpenAI Chat effort case-insensitively', () => {
    for (const effort of THINK_LEVELS) {
      const request = {
        model: 'target',
        messages: [],
        reasoning_effort: effort.toUpperCase(),
      };
      expect(extractReasoningIntent(request)).toEqual({
        effort,
        enabled: effort !== 'none',
      });
    }
  });

  it('prefers decoded unified reasoning and ignores malformed native effort', () => {
    expect(extractReasoningIntent({
      model: 'target',
      messages: [],
      reasoning: { effort: 'high', enabled: true },
      reasoning_effort: 'low',
    })).toMatchObject({ effort: 'high', enabled: true });
    expect(extractReasoningIntent({
      model: 'target',
      messages: [],
      reasoning_effort: 'turbo',
    })).toBeUndefined();
  });
});

describe('resolveReasoningEffort', () => {
  it.each(THINK_LEVELS)('preserves exact configured level %s', (effort) => {
    expect(resolveReasoningEffort(effort, 'custom', {
      modelConfigs: [{ id: 'custom', thinkingLevels: [...THINK_LEVELS] }],
    })).toBe(effort);
  });

  it('preserves exact canonical Codex xhigh', () => {
    expect(resolveReasoningEffort('xhigh', 'gpt-5.3-codex')).toBe('xhigh');
  });

  it.each([
    'gpt-5.6',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
  ])('preserves canonical GPT-5.6 max for %s', (model) => {
    expect(resolveReasoningEffort('max', model)).toBe('max');
  });

  it('keeps GPT-5.3-Codex capped at its documented xhigh maximum', () => {
    expect(resolveReasoningEffort('max', 'gpt-5.3-codex')).toBe('xhigh');
  });

  it.each([
    ['xhigh', 'max'],
    ['medium', 'high'],
  ] as Array<[ThinkLevel, ThinkLevel]>)('maps sparse %s to nearest %s', (requested, expected) => {
    expect(resolveReasoningEffort(requested, 'sparse', {
      modelConfigs: [{ id: 'sparse', thinkingLevels: ['high', 'max'] }],
    })).toBe(expected);
  });

  it('breaks equal-distance ties toward lower effort', () => {
    expect(resolveReasoningEffort('medium', 'tie', {
      modelConfigs: [{ id: 'tie', thinkingLevels: ['low', 'max'] }],
    })).toBe('low');
  });

  it('uses row overrides instead of canonical levels', () => {
    expect(resolveReasoningEffort('xhigh', 'gpt-5.3-codex', {
      modelConfigs: [{ id: 'gpt-5.3-codex', thinkingLevels: ['low', 'high'] }],
    })).toBe('high');
  });

  it('preserves recognized effort for unknown models', () => {
    expect(resolveReasoningEffort('max', 'unknown-model')).toBe('max');
  });

  it('keeps none isolated in both directions', () => {
    expect(resolveReasoningEffort('none', 'enabled-only', {
      modelConfigs: [{ id: 'enabled-only', thinkingLevels: ['high', 'max'] }],
    })).toBe('none');
    expect(resolveReasoningEffort('minimal', 'contains-none', {
      modelConfigs: [{ id: 'contains-none', thinkingLevels: ['none', 'high'] }],
    })).toBe('high');
  });
});
