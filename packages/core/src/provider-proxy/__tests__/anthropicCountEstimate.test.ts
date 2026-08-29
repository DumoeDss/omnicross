/**
 * Unit tests for the core-local count_tokens estimator
 * (`claude-api-protocol-fidelity`, capability anthropic-count-tokens /
 * design D1): monotonicity, tools/thinking participation, the image constant,
 * cache_control neutrality, and the budget-guard degrade path.
 *
 * @module provider-proxy/__tests__/anthropicCountEstimate.test
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COUNT_ESTIMATE_BUDGET_MS,
  ESTIMATED_TOKENS_PER_IMAGE_BLOCK,
  estimateAnthropicInputTokens,
} from '../ingress/anthropicCountEstimate';

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'ping' }],
    ...over,
  };
}

describe('estimateAnthropicInputTokens', () => {
  it('returns a positive number for a minimal body and ~chars/4 for plain text', () => {
    const text = 'a'.repeat(400);
    const n = estimateAnthropicInputTokens(body({ messages: [{ role: 'user', content: text }] }));
    expect(n).toBeGreaterThan(0);
    // 400 chars ≈ 100 tokens (± small constants): same ballpark, not exact.
    expect(n).toBeGreaterThan(50);
    expect(n).toBeLessThan(200);
  });

  it('is monotonic in text volume', () => {
    const small = estimateAnthropicInputTokens(
      body({ messages: [{ role: 'user', content: 'a'.repeat(200) }] }),
    );
    const large = estimateAnthropicInputTokens(
      body({ messages: [{ role: 'user', content: 'a'.repeat(2000) }] }),
    );
    expect(large).toBeGreaterThan(small);
  });

  it('counts system (string and block array forms)', () => {
    const asString = estimateAnthropicInputTokens(body({ system: 's'.repeat(400) }));
    const asBlocks = estimateAnthropicInputTokens(
      body({ system: [{ type: 'text', text: 's'.repeat(400) }] }),
    );
    const none = estimateAnthropicInputTokens(body());
    expect(asString).toBeGreaterThan(none);
    expect(asBlocks).toBe(none + 100); // 400 chars / 4 = 100 tokens exactly
  });

  it('counts thinking and tool_result text blocks', () => {
    const plain = estimateAnthropicInputTokens(
      body({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }] }] }),
    );
    const withThinking = estimateAnthropicInputTokens(
      body({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'x'.repeat(400) },
              { type: 'text', text: 'x'.repeat(400) },
            ],
          },
        ],
      }),
    );
    const withToolResult = estimateAnthropicInputTokens(
      body({
        messages: [
          { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(400) }] },
        ],
      }),
    );
    expect(withThinking).toBeGreaterThan(plain);
    expect(withToolResult).toBeGreaterThan(0);
  });

  it('counts tools by serialized schema size (strictly larger with a big schema)', () => {
    const without = estimateAnthropicInputTokens(body());
    const withTools = estimateAnthropicInputTokens(
      body({
        tools: [
          {
            name: 'big_tool',
            description: 'd'.repeat(4000),
            input_schema: { type: 'object', properties: Object.fromEntries(
              Array.from({ length: 20 }, (_, i) => [`p${i}`, { type: 'string', description: 'x'.repeat(50) }]),
            ) },
          },
        ],
      }),
    );
    expect(withTools).toBeGreaterThan(without + 500);
  });

  it('counts image blocks at the fixed constant', () => {
    const text = estimateAnthropicInputTokens(
      body({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
    );
    const withOneImage = estimateAnthropicInputTokens(
      body({
        messages: [
          { role: 'user', content: [{ type: 'image', source: { type: 'base64' } }, { type: 'text', text: 'hi' }] },
        ],
      }),
    );
    expect(withOneImage - text).toBe(ESTIMATED_TOKENS_PER_IMAGE_BLOCK);
  });

  it('cache_control markers do not change the count', () => {
    const plain = estimateAnthropicInputTokens(
      body({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }] }] }),
    );
    const cached = estimateAnthropicInputTokens(
      body({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'x'.repeat(400), cache_control: { type: 'ephemeral' } }] },
        ],
      }),
    );
    expect(cached).toBe(plain);
  });

  it('budget guard: a tiny budget still yields a positive estimate (degrade, never fail)', () => {
    // 10_000 messages × 1000 chars would walk 10M chars; a 1ms budget allows
    // only ~100k. The estimator must degrade to prefix extrapolation and still
    // return a positive number without throwing.
    const messages = Array.from({ length: 10_000 }, () => ({
      role: 'user',
      content: 'x'.repeat(1000),
    }));
    const n = estimateAnthropicInputTokens(body({ messages }), 1);
    expect(n).toBeGreaterThan(0);
    expect(Number.isFinite(n)).toBe(true);
  });

  it('budget guard: extrapolated estimate stays in the same order of magnitude as full walk', () => {
    const messages = Array.from({ length: 2000 }, () => ({
      role: 'user',
      content: 'x'.repeat(1000),
    }));
    const full = estimateAnthropicInputTokens(body({ messages }), DEFAULT_COUNT_ESTIMATE_BUDGET_MS);
    const guarded = estimateAnthropicInputTokens(body({ messages }), 1);
    // Extrapolation from a uniform prefix should land within 3× of the full walk.
    expect(guarded).toBeGreaterThan(full / 3);
    expect(guarded).toBeLessThan(full * 3);
  });

  it('never throws on hostile shapes', () => {
    expect(() => estimateAnthropicInputTokens(body({ messages: [null, 42, 'str', {}] }))).not.toThrow();
    expect(() => estimateAnthropicInputTokens(body({ tools: [BigInt(1) as unknown as object] }), 10)).not.toThrow();
    expect(estimateAnthropicInputTokens(body({ messages: 'not-an-array' }))).toBeGreaterThanOrEqual(0);
  });
});
