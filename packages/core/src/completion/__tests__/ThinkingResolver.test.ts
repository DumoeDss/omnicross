import { DEFAULT_MAX_TOKENS } from '@omnicross/contracts/thinking-config';
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../ports/logger';
import type { ProviderConfigSource } from '../../ports/provider-config-source';
import { getRequiredMaxTokens, resolveEffectiveMaxTokens } from '../ThinkingResolver';

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function makeConfig(globalMaxTokens?: { enabled: boolean; value: number }): ProviderConfigSource {
  return {
    getGlobalModelParameters: vi.fn(async () =>
      globalMaxTokens ? { maxTokens: globalMaxTokens } : undefined
    ),
    getDiscoveredModelMaxTokens: vi.fn(async () => 384_000),
  } as unknown as ProviderConfigSource;
}

const getProviderWithCapability = vi.fn(async () => ({
  modelConfigs: [{ id: 'deepseek-v4-flash', maxTokens: 384_000 }],
}));

describe('ThinkingResolver max token semantics', () => {
  it('preserves an explicit session output cap', async () => {
    const result = await resolveEffectiveMaxTokens(
      makeConfig(),
      getProviderWithCapability as never,
      makeLogger(),
      'deepseek',
      'deepseek-v4-flash',
      12_345
    );

    expect(result).toBe(12_345);
  });

  it('preserves an explicitly enabled global output cap', async () => {
    const result = await resolveEffectiveMaxTokens(
      makeConfig({ enabled: true, value: 23_456 }),
      getProviderWithCapability as never,
      makeLogger(),
      'deepseek',
      'deepseek-v4-flash'
    );

    expect(result).toBe(23_456);
  });

  it('does not turn model capability or discovery limits into request parameters', async () => {
    const config = makeConfig();
    const providerLookup = vi.fn(getProviderWithCapability);
    const result = await resolveEffectiveMaxTokens(
      config,
      providerLookup as never,
      makeLogger(),
      'deepseek',
      'deepseek-v4-flash'
    );

    expect(result).toBeUndefined();
    expect(providerLookup).not.toHaveBeenCalled();
    expect(config.getDiscoveredModelMaxTokens).not.toHaveBeenCalled();
  });

  it('supplies a fallback only at a protocol boundary that requires max_tokens', async () => {
    const result = await getRequiredMaxTokens(
      makeConfig(),
      getProviderWithCapability as never,
      makeLogger(),
      'anthropic',
      'claude-sonnet-4-5'
    );

    expect(result).toBe(DEFAULT_MAX_TOKENS);
  });
});
