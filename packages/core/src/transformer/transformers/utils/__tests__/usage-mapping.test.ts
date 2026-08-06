/**
 * usage-mapping — regression tests for Anthropic prompt-cache preservation
 * across the Anthropic ↔ OpenAI/Responses usage conversions.
 *
 * Hero case: a real z.ai Anthropic-endpoint trace (2026-08-06) returned
 * `{ input_tokens: 52, output_tokens: 321, cache_read_input_tokens: 7040 }`
 * for the second turn of a conversation (52 fresh tokens, 7040 served from
 * cache). Pre-fix, every Anthropic→OpenAI converter dropped the cache field,
 * so the dashboard recorded `cacheRead=0` and `input=52` — 7040 tokens
 * vanished. These tests pin the post-fix accounting.
 *
 * @module transformer/transformers/utils/__tests__/usage-mapping.test
 */

import { describe, expect, it } from 'vitest';

import {
  anthropicUsageToChatUsage,
  chatUsageToResponsesUsage,
  responsesUsageToChatUsage,
} from '../usage-mapping';

describe('anthropicUsageToChatUsage', () => {
  it('returns undefined for a falsy usage block', () => {
    expect(anthropicUsageToChatUsage(undefined)).toBeUndefined();
  });

  it('maps a no-cache usage block identically to the legacy shape', () => {
    expect(anthropicUsageToChatUsage({ input_tokens: 10, output_tokens: 5 })).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  it('folds cache-read into prompt_tokens and surfaces cached_tokens (hero regression)', () => {
    // z.ai Anthropic endpoint, conversation turn 2: 52 fresh + 7040 cached.
    const usage = anthropicUsageToChatUsage({
      input_tokens: 52,
      output_tokens: 321,
      cache_read_input_tokens: 7040,
    });
    expect(usage).toEqual({
      prompt_tokens: 7092, // 52 fresh + 7040 cached
      completion_tokens: 321,
      total_tokens: 7413,
      prompt_tokens_details: { cached_tokens: 7040 },
    });
  });

  it('folds cache-creation into prompt_tokens but does not report it as cached', () => {
    // Cache-create has no OpenAI field: bill it at the input rate by folding
    // it into prompt_tokens, and never claim it as cached_tokens.
    const usage = anthropicUsageToChatUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 200,
    });
    expect(usage).toEqual({
      prompt_tokens: 300, // 100 fresh + 200 cache-create
      completion_tokens: 50,
      total_tokens: 350,
    });
    expect(usage).not.toHaveProperty('prompt_tokens_details');
  });

  it('handles cache-read + cache-creation together', () => {
    const usage = anthropicUsageToChatUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 200,
    });
    expect(usage).toEqual({
      prompt_tokens: 1300, // 100 + 1000 cache-read + 200 cache-create
      completion_tokens: 50,
      total_tokens: 1350,
      prompt_tokens_details: { cached_tokens: 1000 }, // cache-read only
    });
  });
});

describe('chatUsageToResponsesUsage', () => {
  it('returns undefined for a falsy usage block', () => {
    expect(chatUsageToResponsesUsage(undefined)).toBeUndefined();
  });

  it('carries prompt_tokens_details.cached_tokens → input_tokens_details.cached_tokens', () => {
    const usage = chatUsageToResponsesUsage({
      prompt_tokens: 7092,
      completion_tokens: 321,
      total_tokens: 7413,
      prompt_tokens_details: { cached_tokens: 7040 },
    });
    expect(usage).toEqual({
      input_tokens: 7092,
      output_tokens: 321,
      total_tokens: 7413,
      input_tokens_details: { cached_tokens: 7040 },
    });
  });

  it('omits the detail block when no cached_tokens are present', () => {
    const usage = chatUsageToResponsesUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    expect(usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
    expect(usage).not.toHaveProperty('input_tokens_details');
  });
});

describe('responsesUsageToChatUsage', () => {
  it('returns undefined for a falsy usage block', () => {
    expect(responsesUsageToChatUsage(undefined)).toBeUndefined();
  });

  it('carries input_tokens_details.cached_tokens → prompt_tokens_details.cached_tokens', () => {
    const usage = responsesUsageToChatUsage({
      input_tokens: 7092,
      output_tokens: 321,
      total_tokens: 7413,
      input_tokens_details: { cached_tokens: 7040 },
    });
    expect(usage).toEqual({
      prompt_tokens: 7092,
      completion_tokens: 321,
      total_tokens: 7413,
      prompt_tokens_details: { cached_tokens: 7040 },
    });
  });
});

describe('end-to-end billable math (the property the ingress reader relies on)', () => {
  it('a Responses reader computes billable = input_tokens - cached_tokens = fresh input', () => {
    // Simulate the full Anthropic → Chat → Responses chain, then the exact
    // arithmetic recordResponsesUsage performs on the result.
    const anthropicUsage = {
      input_tokens: 52, // fresh, excludes cache
      output_tokens: 321,
      cache_read_input_tokens: 7040,
    };
    const chat = anthropicUsageToChatUsage(anthropicUsage)!;
    const responses = chatUsageToResponsesUsage(chat)!;

    const inputTokens = Number(responses.input_tokens) || 0;
    const details = (responses.input_tokens_details ?? {}) as Record<string, unknown>;
    const cacheReadTokens = Number(details.cached_tokens) || 0;
    const billableInput = Math.max(0, inputTokens - cacheReadTokens);

    expect(cacheReadTokens).toBe(7040); // cache no longer dropped
    expect(billableInput).toBe(52); // the 52 fresh tokens survive, not 0
  });
});
