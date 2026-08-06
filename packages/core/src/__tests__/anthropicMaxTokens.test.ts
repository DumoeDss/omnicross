/**
 * `resolveAnthropicMaxTokens` — output-ceiling resolution for native Anthropic
 * Messages requests.
 *
 * Regression context: the previous `?? 4096` fallback capped every request
 * whose caller did not pass an explicit cap at 4096 output tokens. On a
 * 128K-output model that truncates long responses silently, and when the cut
 * lands inside a tool call's JSON arguments the host reports a malformed tool
 * call instead of a token-limit hit.
 *
 * @module __tests__/anthropicMaxTokens.test
 */

import { describe, expect, it } from 'vitest';

import { ANTHROPIC_FALLBACK_MAX_TOKENS, resolveAnthropicMaxTokens } from '../anthropicMaxTokens';

describe('resolveAnthropicMaxTokens', () => {
  it('honors an explicit caller cap verbatim, including small values', () => {
    expect(resolveAnthropicMaxTokens('claude-opus-4-8', 512)).toBe(512);
    expect(resolveAnthropicMaxTokens('claude-opus-4-8', 4096)).toBe(4096);
    expect(resolveAnthropicMaxTokens('an-unknown-model', 2048)).toBe(2048);
  });

  it("falls back to the model's canonical ceiling when no cap is supplied", () => {
    // 64000 (not the 128000 fallback) — proves the registry is really consulted
    // rather than every path coincidentally landing on the constant.
    expect(resolveAnthropicMaxTokens('claude-haiku-4-5')).toBe(64000);
  });

  it('resolves claude-opus-4-8 to its full 128K ceiling, not 4096', () => {
    const resolved = resolveAnthropicMaxTokens('claude-opus-4-8');
    expect(resolved).toBe(128000);
    expect(resolved).not.toBe(4096);
  });

  it('normalizes ids through the canonical registry', () => {
    // Publisher prefix + tag suffix must still resolve to the same ceiling.
    expect(resolveAnthropicMaxTokens('anthropic/claude-opus-4-8:beta')).toBe(128000);
    expect(resolveAnthropicMaxTokens('CLAUDE-OPUS-4-8')).toBe(128000);
  });

  it('falls back to the frontier ceiling for models absent from the registry', () => {
    expect(resolveAnthropicMaxTokens('some-relay-only-alias')).toBe(ANTHROPIC_FALLBACK_MAX_TOKENS);
    expect(ANTHROPIC_FALLBACK_MAX_TOKENS).toBe(128_000);
  });

  it('treats non-positive and non-finite caps as "not supplied"', () => {
    for (const bad of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '8192']) {
      expect(resolveAnthropicMaxTokens('claude-haiku-4-5', bad)).toBe(64000);
    }
  });

  it('falls back when the model id itself is missing', () => {
    expect(resolveAnthropicMaxTokens(undefined)).toBe(ANTHROPIC_FALLBACK_MAX_TOKENS);
    expect(resolveAnthropicMaxTokens('')).toBe(ANTHROPIC_FALLBACK_MAX_TOKENS);
  });
});
