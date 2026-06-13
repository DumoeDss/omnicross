/**
 * model-shape tests — OpenCodeGo upstream shape classification.
 *
 * Covers the GO-half detector (back-compat), the ZEN classifier
 * (`classifyZenShape`) incl. the deliberate `qwen*` over-capture FIX (LEAD Q2),
 * the unified `(provider, modelId) → shape` resolver, and the half resolver that
 * recovers a model's provider half from the user config.
 */

import type { OpenCodeGoTokenConfig } from '@omnicross/contracts/subscription-types';
import { describe, expect, it } from 'vitest';

import {
  classifyZenShape,
  detectOpenCodeGoShape,
  resolveOpenCodeGoHalf,
  resolveOpenCodeGoShape,
} from '../model-shape';

describe('detectOpenCodeGoShape (GO half, back-compat)', () => {
  it('detects MiniMax as anthropic-shape', () => {
    expect(detectOpenCodeGoShape('minimax-m2.5')).toBe('anthropic');
    expect(detectOpenCodeGoShape('MINIMAX-M2.5')).toBe('anthropic');
    expect(detectOpenCodeGoShape('minimax_m2.5')).toBe('anthropic');
  });

  it('detects everything else as chat-shape', () => {
    expect(detectOpenCodeGoShape('kimi-k2.6')).toBe('chat');
    expect(detectOpenCodeGoShape('glm-5')).toBe('chat');
    expect(detectOpenCodeGoShape('mimo-v2-pro')).toBe('chat');
    // qwen3.6-plus on the GO half is chat (the go classifier only knows minimax).
    expect(detectOpenCodeGoShape('qwen3.6-plus')).toBe('chat');
  });

  it('is case-insensitive', () => {
    expect(detectOpenCodeGoShape('Kimi-K2.6')).toBe('chat');
    expect(detectOpenCodeGoShape('MiniMax-M2.5')).toBe('anthropic');
  });
});

describe('classifyZenShape (ZEN half — ported ClassifyEndpoint)', () => {
  it('claude* → anthropic', () => {
    expect(classifyZenShape('claude-sonnet-4.5')).toBe('anthropic');
    expect(classifyZenShape('claude-opus-4.1')).toBe('anthropic');
  });

  it('minimax* → anthropic', () => {
    expect(classifyZenShape('minimax-m2.5')).toBe('anthropic');
  });

  it('explicit qwen3.7-max → anthropic', () => {
    expect(classifyZenShape('qwen3.7-max')).toBe('anthropic');
  });

  it('Q2 FIX: a NON-qwen3.7-max qwen id is NOT over-captured to anthropic → chat', () => {
    // Negative control: if the qwen* PREFIX (the reference bug) were ported, this
    // would be 'anthropic'. The fix routes it to chat.
    expect(classifyZenShape('qwen3.6-plus')).toBe('chat');
    expect(classifyZenShape('qwen3.5-plus')).toBe('chat');
    expect(classifyZenShape('qwen-turbo')).toBe('chat');
  });

  it('gpt-5* / *-codex → responses', () => {
    expect(classifyZenShape('gpt-5')).toBe('responses');
    expect(classifyZenShape('gpt-5-codex')).toBe('responses');
    expect(classifyZenShape('gpt-5.1-codex-max')).toBe('responses');
    expect(classifyZenShape('gpt-5.5-pro')).toBe('responses');
    // *-codex suffix even outside the gpt-5 family.
    expect(classifyZenShape('o4-codex')).toBe('responses');
  });

  it('gemini-* → gemini (forward-compatible prefix superset)', () => {
    expect(classifyZenShape('gemini-3-flash')).toBe('gemini');
    expect(classifyZenShape('gemini-3.5-flash')).toBe('gemini');
    expect(classifyZenShape('gemini-3.1-pro')).toBe('gemini');
    // A near-future id the reference's 3-id list would miss.
    expect(classifyZenShape('gemini-4-ultra')).toBe('gemini');
  });

  it('unknown → chat', () => {
    expect(classifyZenShape('kimi-k2.6')).toBe('chat');
    expect(classifyZenShape('glm-5')).toBe('chat');
    expect(classifyZenShape('mystery-model')).toBe('chat');
  });

  it('is case-insensitive', () => {
    expect(classifyZenShape('Claude-Sonnet')).toBe('anthropic');
    expect(classifyZenShape('GEMINI-3-FLASH')).toBe('gemini');
    expect(classifyZenShape('GPT-5-CODEX')).toBe('responses');
  });
});

describe('resolveOpenCodeGoShape (unified (provider, modelId) → shape)', () => {
  it('go half preserves the minimax→anthropic / else→chat rule', () => {
    expect(resolveOpenCodeGoShape({ provider: 'go', modelId: 'minimax-m2.5' })).toBe('anthropic');
    expect(resolveOpenCodeGoShape({ provider: 'go', modelId: 'kimi-k2.6' })).toBe('chat');
    // qwen3.7-max on the GO half is NOT anthropic (go classifier only knows minimax).
    expect(resolveOpenCodeGoShape({ provider: 'go', modelId: 'qwen3.7-max' })).toBe('chat');
  });

  it('absent provider defaults to go', () => {
    expect(resolveOpenCodeGoShape({ modelId: 'minimax-m2.5' })).toBe('anthropic');
    expect(resolveOpenCodeGoShape({ modelId: 'gemini-3-flash' })).toBe('chat'); // go half → not gemini
  });

  it('zen half runs classifyZenShape', () => {
    expect(resolveOpenCodeGoShape({ provider: 'zen', modelId: 'claude-sonnet-4.5' })).toBe('anthropic');
    expect(resolveOpenCodeGoShape({ provider: 'zen', modelId: 'qwen3.7-max' })).toBe('anthropic');
    expect(resolveOpenCodeGoShape({ provider: 'zen', modelId: 'gpt-5-codex' })).toBe('responses');
    expect(resolveOpenCodeGoShape({ provider: 'zen', modelId: 'gemini-3-flash' })).toBe('gemini');
    expect(resolveOpenCodeGoShape({ provider: 'zen', modelId: 'kimi-k2.6' })).toBe('chat');
    expect(resolveOpenCodeGoShape({ provider: 'zen', modelId: 'qwen3.6-plus' })).toBe('chat');
  });
});

describe('resolveOpenCodeGoHalf (recover half from config)', () => {
  const cfg = (over: Partial<OpenCodeGoTokenConfig>): OpenCodeGoTokenConfig => ({
    authMethod: 'manual',
    status: 'configured',
    ...over,
  });

  it('returns go when config is undefined', () => {
    expect(resolveOpenCodeGoHalf('claude-sonnet-4.5', undefined)).toBe('go');
  });

  it('returns the modelMap entry half when the id matches', () => {
    const c = cfg({ modelMap: { default: { modelId: 'claude-sonnet-4.5', provider: 'zen' } } });
    expect(resolveOpenCodeGoHalf('claude-sonnet-4.5', c)).toBe('zen');
  });

  it('returns the fallbacks entry half when the id matches', () => {
    const c = cfg({ fallbacks: { default: [{ modelId: 'gpt-5-codex', provider: 'zen' }] } });
    expect(resolveOpenCodeGoHalf('gpt-5-codex', c)).toBe('zen');
  });

  it('defaults an entry with no provider field to go', () => {
    const c = cfg({ modelMap: { default: { modelId: 'kimi-k2.6' } } });
    expect(resolveOpenCodeGoHalf('kimi-k2.6', c)).toBe('go');
  });

  it('returns go for an id absent from all user entries (defaults stay go)', () => {
    const c = cfg({ modelMap: { default: { modelId: 'claude-sonnet-4.5', provider: 'zen' } } });
    expect(resolveOpenCodeGoHalf('some-default-model', c)).toBe('go');
  });
});
