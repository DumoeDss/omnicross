/**
 * providerForWire — the multi-format fan-out view swap (dual/tri-wire
 * providers, one key). Pure function: no variant or a variant matching the
 * row's RESOLVED primary format returns the row untouched; otherwise the view
 * swaps base + format so the ingress takes its verbatim relay path.
 *
 * @module @omnicross/core/provider-proxy/ingress/__tests__/providerForWire.test
 */

import { describe, expect, it } from 'vitest';

import type { LLMProvider } from '@omnicross/contracts/llm-config';

import { providerForWire } from '../providerProxyShared';

const row: LLMProvider = {
  id: 'deepseek',
  name: 'DeepSeek',
  apiFormat: 'openai',
  api_base_url: 'https://api.deepseek.com/v1/chat/completions',
  api_key: 'sk-shared',
  models: ['deepseek-flash'],
  enabled: true,
  formatVariants: {
    anthropic: 'https://api.deepseek.com/anthropic',
    'openai-response': 'https://api.deepseek.com',
  },
};

describe('providerForWire', () => {
  it('swaps base + format for a declared variant (verbatim fan-out view)', () => {
    const view = providerForWire(row, 'anthropic');
    expect(view.apiFormat).toBe('anthropic');
    expect(view.api_base_url).toBe('https://api.deepseek.com/anthropic');
    // Same key, same identity — the routing/mapping/usage spine is unchanged.
    expect(view.api_key).toBe('sk-shared');
    expect(view.id).toBe('deepseek');
    // Deprecated format axes are cleared so resolveApiFormat cannot fall back
    // to the stored format.
    expect(view.chatApiFormat).toBeUndefined();
    expect(view.apiType).toBeUndefined();
  });

  it('returns the row untouched for its own primary wire', () => {
    expect(providerForWire(row, 'openai')).toBe(row);
  });

  it('returns the row untouched for an undeclared wire', () => {
    const bare: LLMProvider = { ...row, formatVariants: undefined };
    expect(providerForWire(bare, 'anthropic')).toBe(bare);
  });

  it('honors the RESOLVED primary (legacy rows without apiFormat)', () => {
    const legacy: LLMProvider = {
      ...row,
      apiFormat: undefined,
      apiType: 'anthropic',
      api_base_url: 'https://api.deepseek.com/anthropic',
    };
    // The resolved format IS anthropic — the variant would just restate the
    // primary base, so the row comes back untouched (no base swap).
    expect(providerForWire(legacy, 'anthropic')).toBe(legacy);
    // But an openai-response variant still fans out.
    const view = providerForWire(legacy, 'openai-response');
    expect(view.apiFormat).toBe('openai-response');
    expect(view.api_base_url).toBe('https://api.deepseek.com');
  });
});
