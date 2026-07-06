/**
 * modelPrefixDispatch tests (openai-chat-bridge #11, design D2). The pure
 * `classifyModelPrefix` + `resolvePrefixTarget` helpers: case-insensitive,
 * token-anchored prefix classification (claude / gpt / gemini + OpenAI o-series),
 * and target resolution that treats an unknown prefix OR an unconfigured target
 * as "unroutable" (null).
 */
import { describe, expect, it } from 'vitest';

import { classifyModelPrefix, resolvePrefixTarget } from '../modelPrefixDispatch';
import type { ModelPrefixTargets } from '../types';

describe('classifyModelPrefix', () => {
  it('classifies claude / gpt / gemini versioned ids (case-insensitive)', () => {
    expect(classifyModelPrefix('claude-sonnet-4-5')).toBe('claude');
    expect(classifyModelPrefix('Claude-Opus-4-8')).toBe('claude');
    expect(classifyModelPrefix('gpt-4o')).toBe('gpt');
    expect(classifyModelPrefix('GPT-5-codex')).toBe('gpt');
    expect(classifyModelPrefix('gemini-2.5-pro')).toBe('gemini');
    expect(classifyModelPrefix('GEMINI-3-flash')).toBe('gemini');
  });

  it('classifies the bare vendor token', () => {
    expect(classifyModelPrefix('claude')).toBe('claude');
    expect(classifyModelPrefix('gpt')).toBe('gpt');
    expect(classifyModelPrefix('gemini')).toBe('gemini');
  });

  it('classifies the OpenAI o-series (o1 / o3-mini / o4) as gpt', () => {
    expect(classifyModelPrefix('o1')).toBe('gpt');
    expect(classifyModelPrefix('o3-mini')).toBe('gpt');
    expect(classifyModelPrefix('o4-preview')).toBe('gpt');
  });

  it('is token-anchored, not a substring (my-gpt-thing is NOT gpt)', () => {
    expect(classifyModelPrefix('my-gpt-thing')).toBeNull();
    expect(classifyModelPrefix('anthropic-claude')).toBeNull();
    expect(classifyModelPrefix('open-gemini')).toBeNull();
    // `o` followed by a non-digit is not the o-series.
    expect(classifyModelPrefix('opus-4')).toBeNull();
  });

  it('returns null for unknown / empty / blank', () => {
    expect(classifyModelPrefix('deepseek-v3')).toBeNull();
    expect(classifyModelPrefix('glm-4.7')).toBeNull();
    expect(classifyModelPrefix('')).toBeNull();
    expect(classifyModelPrefix('   ')).toBeNull();
    expect(classifyModelPrefix(undefined)).toBeNull();
  });
});

describe('resolvePrefixTarget', () => {
  const targets: ModelPrefixTargets = {
    claude: 'claude,claude-sonnet-4-5',
    gpt: 'openai,gpt-4o',
  };

  it('resolves the configured target for a matched prefix', () => {
    expect(resolvePrefixTarget(targets, 'claude-opus-4-8')).toEqual({
      kind: 'claude',
      ref: 'claude,claude-sonnet-4-5',
    });
    expect(resolvePrefixTarget(targets, 'gpt-5-codex')).toEqual({
      kind: 'gpt',
      ref: 'openai,gpt-4o',
    });
  });

  it('returns null when the matched prefix has no configured target', () => {
    // gemini classifies but is not in `targets`.
    expect(resolvePrefixTarget(targets, 'gemini-2.5-pro')).toBeNull();
  });

  it('returns null for an unknown prefix', () => {
    expect(resolvePrefixTarget(targets, 'deepseek-v3')).toBeNull();
  });

  it('returns null when targets are absent or the target is blank', () => {
    expect(resolvePrefixTarget(undefined, 'claude-x')).toBeNull();
    expect(resolvePrefixTarget({ claude: '   ' }, 'claude-x')).toBeNull();
  });
});
