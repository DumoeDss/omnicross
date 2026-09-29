/**
 * resolveResponsesRouteProfile — the OFFICIAL-ONLY responses-variant gate.
 *
 * A third-party Responses-compatible row (commandcode &c.) advertises the
 * wire but rejects OpenAI-exclusive tool types (namespace / web_search) that
 * a verbatim NATIVE relay forwards untouched (production: every codex turn
 * 400 invalid_request_error). Non-official rows must keep their PRIMARY wire
 * and classify REDUCED (translation + hosted-tool degradation); official rows
 * keep the verbatim variant.
 *
 * @module provider-proxy/responses/__tests__/responsesRouteProfile.test
 */
import { describe, expect, it, vi } from 'vitest';

import type { ProviderConfigSource } from '@omnicross/core/ports/provider-config-source';

import { resolveResponsesRouteProfile } from '../responsesDriver';

function llmConfig(row: Record<string, unknown>): ProviderConfigSource {
  return {
    getProvider: vi.fn(async () => row),
    resolveTransformerChain: vi.fn(async () => ({ providerTransformers: [], modelTransformers: [] })),
  } as unknown as ProviderConfigSource;
}

const BASE_ROW = {
  id: 'commandcode',
  name: 'Command Code',
  apiFormat: 'openai',
  api_base_url: 'https://api.commandcode.ai/provider/v1',
  api_key: 'sk-x',
  models: ['deepseek/deepseek-v4.1-flash'],
  enabled: true,
  formatVariants: { 'openai-response': 'https://api.commandcode.ai/provider/v1/responses' },
};

function route(): Parameters<typeof resolveResponsesRouteProfile>[0] {
  return {
    authMode: 'byo',
    providerId: 'commandcode',
    ingressFormat: 'openai-responses',
    targetProviderFormat: 'transform',
    model: 'deepseek/deepseek-v4.1-flash',
    sessionId: 's1',
  } as unknown as Parameters<typeof resolveResponsesRouteProfile>[0];
}

describe('resolveResponsesRouteProfile (BYO official-only variant gate)', () => {
  it('a THIRD-PARTY row with a responses variant stays on the PRIMARY wire and classifies REDUCED', async () => {
    const resolved = await resolveResponsesRouteProfile(route(), { llmConfig: llmConfig(BASE_ROW) } as never, 'deepseek/deepseek-v4.1-flash');
    expect(resolved.profile).toBe('reduced');
    // The stored row — NOT the variant view: URL + translation chain must
    // derive from the same (primary chat) wire.
    expect(resolved.provider.api_base_url).toBe('https://api.commandcode.ai/provider/v1');
  });

  it('an OFFICIAL row with a responses variant classifies NATIVE and uses the variant base', async () => {
    const resolved = await resolveResponsesRouteProfile(
      route(),
      { llmConfig: llmConfig({ ...BASE_ROW, isOfficial: true }) } as never,
      'gpt-6-sol',
    );
    expect(resolved.profile).toBe('native');
    expect(resolved.provider.api_base_url).toBe('https://api.commandcode.ai/provider/v1/responses');
  });

  it('an official row whose PRIMARY is openai-response (no variant needed) classifies NATIVE', async () => {
    const resolved = await resolveResponsesRouteProfile(
      route(),
      { llmConfig: llmConfig({ ...BASE_ROW, apiFormat: 'openai-response', formatVariants: undefined, isOfficial: true }) } as never,
      'gpt-6-sol',
    );
    expect(resolved.profile).toBe('native');
  });
});
