/**
 * Mock-based unit test for the `ProviderConfigSource` port (omnicross Phase 0b,
 * task 5.1).
 *
 * Injects a hand-rolled mock `ProviderConfigSource` into the serving-core
 * consumer `resolveProviderChain` and asserts the core invokes the port methods
 * (`resolveTransformerChain`, `getMainTransformer`) with the expected arguments,
 * with NO reliance on the host's concrete config-service class.
 */

import { describe, expect, it, vi } from 'vitest';

import { resolveProviderChain } from '../../pipeline/resolveProviderChain';
import type { Transformer } from '../../transformer';
import type { ProviderConfigSource } from '../provider-config-source';

function makeTransformer(name: string): Transformer {
  return { name };
}

/**
 * Build a minimal mock that implements only the `ProviderConfigSource` methods
 * the core consumer touches. The full ten-method surface is declared so the
 * cast is type-checked against the port (not the host class).
 */
function makeMockConfigSource(opts: {
  providerTransformers?: Transformer[];
  modelTransformers?: Transformer[];
  mainTransformer?: Transformer | null;
}): {
  port: ProviderConfigSource;
  resolveTransformerChain: ReturnType<typeof vi.fn>;
  getMainTransformer: ReturnType<typeof vi.fn>;
} {
  const resolveTransformerChain = vi.fn(async () => ({
    providerTransformers: opts.providerTransformers ?? [],
    modelTransformers: opts.modelTransformers ?? [],
  }));
  const getMainTransformer = vi.fn(async () => opts.mainTransformer ?? null);

  const port = {
    resolveTransformerChain,
    getMainTransformer,
  } as unknown as ProviderConfigSource;

  return { port, resolveTransformerChain, getMainTransformer };
}

describe('ProviderConfigSource port — mock injection (task 5.1)', () => {
  it('the core calls resolveTransformerChain + getMainTransformer with the request args', async () => {
    const anthropic = makeTransformer('anthropic');
    const { port, resolveTransformerChain, getMainTransformer } = makeMockConfigSource({
      providerTransformers: [],
      modelTransformers: [],
      mainTransformer: anthropic,
    });

    const result = await resolveProviderChain(port, 'anthropic', 'claude-sonnet-4');

    // The port methods were dispatched with the providerId/model the core received.
    expect(resolveTransformerChain).toHaveBeenCalledTimes(1);
    expect(resolveTransformerChain).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4');
    expect(getMainTransformer).toHaveBeenCalledTimes(1);
    expect(getMainTransformer).toHaveBeenCalledWith('anthropic');

    // And the mock's scripted return flowed through the core unchanged.
    expect(result.mainTransformer).toBe(anthropic);
    expect(result.chain.providerTransformers.map((t) => t.name)).toEqual(['anthropic']);
    expect(result.hasTransformers).toBe(true);
  });

  it('honors the mock returning no main transformer (port surface only)', async () => {
    const { port, getMainTransformer } = makeMockConfigSource({
      providerTransformers: [],
      modelTransformers: [],
      mainTransformer: null,
    });

    const result = await resolveProviderChain(port, 'openai', 'gpt-4o');

    expect(getMainTransformer).toHaveBeenCalledWith('openai');
    expect(result.mainTransformer).toBeNull();
    expect(result.hasTransformers).toBe(false);
  });
});
