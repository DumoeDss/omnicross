/**
 * Chain-equivalence assertion for `resolveProviderChain` (task 1.4).
 *
 * Asserts that the shared helper produces the same providerTransformers /
 * modelTransformers order + names + hasTransformers as the former inline
 * logic did at all three call sites. Uses representative stub providers:
 *
 * - "anthropic-style": mainTransformer = AnthropicTransformer (name 'anthropic')
 * - "gemini-style": mainTransformer = GeminiTransformer (name 'gemini')
 * - "openai-style": no mainTransformer (null)
 * - dedupe: mainTransformer already present in providerTransformers → not doubled
 */

import { describe, expect, it, vi } from 'vitest';

import type { ProviderConfigSource } from '../../ports';
import type { Transformer } from '../../transformer';
import { resolveProviderChain } from '../resolveProviderChain';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTransformer(name: string): Transformer {
  return { name };
}

/**
 * Build a minimal ProviderConfigSource stub with scripted return values.
 */
function makeConfigStub(opts: {
  providerTransformers?: Transformer[];
  modelTransformers?: Transformer[];
  mainTransformer?: Transformer | null;
}): ProviderConfigSource {
  return {
    resolveTransformerChain: vi.fn(async () => ({
      providerTransformers: opts.providerTransformers ?? [],
      modelTransformers: opts.modelTransformers ?? [],
    })),
    getMainTransformer: vi.fn(async () => opts.mainTransformer ?? null),
  } as unknown as ProviderConfigSource;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveProviderChain — chain-equivalence assertions (task 1.4)', () => {
  it('Anthropic-style provider: mainTransformer unshifted into providerTransformers', async () => {
    const anthropicTransformer = makeTransformer('anthropic');
    const config = makeConfigStub({
      providerTransformers: [],
      modelTransformers: [],
      mainTransformer: anthropicTransformer,
    });

    const result = await resolveProviderChain(config, 'anthropic', 'claude-3-5-sonnet-20241022');

    expect(result.chain.providerTransformers).toHaveLength(1);
    expect(result.chain.providerTransformers[0].name).toBe('anthropic');
    expect(result.chain.modelTransformers).toHaveLength(0);
    expect(result.mainTransformer).toBe(anthropicTransformer);
    expect(result.hasTransformers).toBe(true);
  });

  it('Gemini-style provider: mainTransformer unshifted before existing providerTransformers', async () => {
    const geminiTransformer = makeTransformer('gemini');
    const existingTransformer = makeTransformer('openrouter');
    const config = makeConfigStub({
      providerTransformers: [existingTransformer],
      modelTransformers: [],
      mainTransformer: geminiTransformer,
    });

    const result = await resolveProviderChain(config, 'google', 'gemini-2.0-flash');

    // gemini should be at index 0 (unshifted), existing at index 1
    expect(result.chain.providerTransformers).toHaveLength(2);
    expect(result.chain.providerTransformers[0].name).toBe('gemini');
    expect(result.chain.providerTransformers[1].name).toBe('openrouter');
    expect(result.mainTransformer).toBe(geminiTransformer);
    expect(result.hasTransformers).toBe(true);
  });

  it('OpenAI-style provider: no mainTransformer → chain unchanged, hasTransformers false when no transformers', async () => {
    const config = makeConfigStub({
      providerTransformers: [],
      modelTransformers: [],
      mainTransformer: null,
    });

    const result = await resolveProviderChain(config, 'openai', 'gpt-4o');

    expect(result.chain.providerTransformers).toHaveLength(0);
    expect(result.chain.modelTransformers).toHaveLength(0);
    expect(result.mainTransformer).toBeNull();
    expect(result.hasTransformers).toBe(false);
  });

  it('hasTransformers true when only modelTransformers present (no mainTransformer)', async () => {
    const reasoningTransformer = makeTransformer('reasoning');
    const config = makeConfigStub({
      providerTransformers: [],
      modelTransformers: [reasoningTransformer],
      mainTransformer: null,
    });

    const result = await resolveProviderChain(config, 'openai', 'o3');

    expect(result.chain.providerTransformers).toHaveLength(0);
    expect(result.chain.modelTransformers).toHaveLength(1);
    expect(result.chain.modelTransformers[0].name).toBe('reasoning');
    expect(result.hasTransformers).toBe(true);
  });

  it('dedupe: mainTransformer already in providerTransformers → NOT unshifted again', async () => {
    const geminiTransformer = makeTransformer('gemini');
    // Simulate a provider config that already includes the main transformer
    const config = makeConfigStub({
      providerTransformers: [geminiTransformer],
      modelTransformers: [],
      mainTransformer: geminiTransformer,
    });

    const result = await resolveProviderChain(config, 'google', 'gemini-2.0-flash');

    // Must NOT be duplicated
    expect(result.chain.providerTransformers).toHaveLength(1);
    expect(result.chain.providerTransformers[0].name).toBe('gemini');
    expect(result.hasTransformers).toBe(true);
  });

  it('dedupe: mainTransformer with same name (different instance) is still deduped', async () => {
    // Match is by .name, not by reference identity
    const inChain = makeTransformer('anthropic');
    const main = makeTransformer('anthropic'); // different instance, same name
    const config = makeConfigStub({
      providerTransformers: [inChain],
      modelTransformers: [],
      mainTransformer: main,
    });

    const result = await resolveProviderChain(config, 'anthropic', 'claude-3-5-sonnet-20241022');

    expect(result.chain.providerTransformers).toHaveLength(1);
    expect(result.chain.providerTransformers[0]).toBe(inChain);
  });

  it('shallow copy: returned providerTransformers is a new array (not the cached reference)', async () => {
    const t = makeTransformer('openai');
    const cachedProviderTransformers = [t];
    const config = makeConfigStub({
      providerTransformers: cachedProviderTransformers,
      modelTransformers: [],
      mainTransformer: null,
    });

    const result = await resolveProviderChain(config, 'openai', 'gpt-4o');

    // Must be a shallow copy, not the original array reference
    expect(result.chain.providerTransformers).not.toBe(cachedProviderTransformers);
    expect(result.chain.providerTransformers[0]).toBe(t); // same transformer instance
  });

  it('transformer order is preserved: unshift puts mainTransformer first', async () => {
    const main = makeTransformer('gemini');
    const t1 = makeTransformer('reasoning');
    const t2 = makeTransformer('cache');
    const config = makeConfigStub({
      providerTransformers: [t1, t2],
      modelTransformers: [],
      mainTransformer: main,
    });

    const result = await resolveProviderChain(config, 'google', 'gemini-2.0-flash');

    expect(result.chain.providerTransformers.map((t) => t.name)).toEqual([
      'gemini',
      'reasoning',
      'cache',
    ]);
  });
});
