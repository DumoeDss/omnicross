/**
 * Defaults parity tests — the built-in OpenCodeGo model map + fallback chain
 * MUST mirror `_others/oc-go-cc/configs/config.example.json` (audit D4 +
 * fallback-list parity). Covers the `complex` → `glm-5.1` fix, the new DORMANT
 * `background` scenario, and every aligned fallback list.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OPENCODEGO_FALLBACKS,
  DEFAULT_OPENCODEGO_MODEL_MAP,
} from '../defaults';
import { nextFallbackEntry } from '../FallbackChain';

describe('DEFAULT_OPENCODEGO_MODEL_MAP', () => {
  it('maps complex to glm-5.1 (D4 fix, was mimo-v2-pro)', () => {
    expect(DEFAULT_OPENCODEGO_MODEL_MAP.complex.modelId).toBe('glm-5.1');
  });

  it('maps background to qwen3.5-plus with reference temperature/maxTokens', () => {
    const bg = DEFAULT_OPENCODEGO_MODEL_MAP.background;
    expect(bg.modelId).toBe('qwen3.5-plus');
    expect(bg.temperature).toBe(0.5);
    expect(bg.maxTokens).toBe(2048);
  });

  it('keeps the untouched primary models aligned to the reference', () => {
    expect(DEFAULT_OPENCODEGO_MODEL_MAP.default.modelId).toBe('kimi-k2.6');
    expect(DEFAULT_OPENCODEGO_MODEL_MAP.long_context.modelId).toBe('minimax-m2.5');
    expect(DEFAULT_OPENCODEGO_MODEL_MAP.think.modelId).toBe('glm-5');
    expect(DEFAULT_OPENCODEGO_MODEL_MAP.fast.modelId).toBe('qwen3.6-plus');
  });
});

describe('DEFAULT_OPENCODEGO_FALLBACKS — full parity with config.example.json', () => {
  const ids = (scenario: keyof typeof DEFAULT_OPENCODEGO_FALLBACKS): string[] =>
    DEFAULT_OPENCODEGO_FALLBACKS[scenario].map((e) => e.modelId);

  it('default → [mimo-v2-pro, qwen3.6-plus]', () => {
    expect(ids('default')).toEqual(['mimo-v2-pro', 'qwen3.6-plus']);
  });

  it('long_context → [minimax-m2.7, kimi-k2.6]', () => {
    expect(ids('long_context')).toEqual(['minimax-m2.7', 'kimi-k2.6']);
  });

  it('think → [kimi-k2.6, mimo-v2-pro]', () => {
    expect(ids('think')).toEqual(['kimi-k2.6', 'mimo-v2-pro']);
  });

  it('complex → [glm-5, kimi-k2.6]', () => {
    expect(ids('complex')).toEqual(['glm-5', 'kimi-k2.6']);
  });

  it('fast → [qwen3.5-plus, minimax-m2.5]', () => {
    expect(ids('fast')).toEqual(['qwen3.5-plus', 'minimax-m2.5']);
  });

  it('background → [qwen3.6-plus, minimax-m2.5] (DORMANT)', () => {
    expect(ids('background')).toEqual(['qwen3.6-plus', 'minimax-m2.5']);
  });
});

describe('nextFallbackEntry walks the background list', () => {
  it('qwen3.6-plus → minimax-m2.5 → null', () => {
    const first = nextFallbackEntry('background', [], undefined);
    expect(first?.modelId).toBe('qwen3.6-plus');
    const second = nextFallbackEntry('background', ['qwen3.6-plus'], undefined);
    expect(second?.modelId).toBe('minimax-m2.5');
    const exhausted = nextFallbackEntry('background', ['qwen3.6-plus', 'minimax-m2.5'], undefined);
    expect(exhausted).toBeNull();
  });
});
