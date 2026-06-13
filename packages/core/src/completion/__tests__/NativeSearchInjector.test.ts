/**
 * NativeSearchInjector Tests
 */

import type { LLMProvider } from '@omnicross/contracts/llm-config';
import { describe, expect, it } from 'vitest';

import type { NativeSearchUserConfig } from '../native-search-types';
import {
  applyAugmentation,
  buildNativeSearchAugmentation,
  detectNativeSearch,
} from '../NativeSearchInjector';

// ============================================================
// Helpers
// ============================================================

function makeProvider(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    id: 'test',
    name: 'Test',
    api_base_url: 'https://api.openai.com/v1',
    api_key: 'sk-test',
    models: [],
    enabled: true,
    ...overrides,
  };
}

const defaultConfig: NativeSearchUserConfig = {
  enabled: true,
  maxResults: 5,
};

// ============================================================
// detectNativeSearch
// ============================================================

describe('detectNativeSearch', () => {
  it('detects OpenAI models via model pattern (Responses API)', () => {
    // OpenAI native web_search is only available via the Responses API
    // ('openai-response'), not Chat Completions ('openai'). See
    // API_FORMAT_PROVIDER_MAP in native-search-types.ts.
    const result = detectNativeSearch('gpt-4o', 'openai-response', makeProvider());
    expect(result).toEqual({ supported: true, nativeProvider: 'openai' });
  });

  it('detects OpenAI o-series models (Responses API)', () => {
    const result = detectNativeSearch('o3-mini', 'openai-response', makeProvider());
    expect(result).toEqual({ supported: true, nativeProvider: 'openai' });
  });

  it('does not auto-detect OpenAI Chat Completions models', () => {
    // Regular models on the Chat Completions API ('openai') do NOT support
    // native search (only search-preview models do, via a special case).
    const result = detectNativeSearch('gpt-4o', 'openai', makeProvider());
    expect(result).toEqual({ supported: false, nativeProvider: null });
  });

  it('detects Anthropic models via model pattern', () => {
    const provider = makeProvider({ api_base_url: 'https://api.anthropic.com' });
    const result = detectNativeSearch('claude-3-5-sonnet', 'anthropic', provider);
    expect(result).toEqual({ supported: true, nativeProvider: 'anthropic' });
  });

  it('detects Google Gemini models via model pattern', () => {
    const provider = makeProvider({ api_base_url: 'https://generativelanguage.googleapis.com' });
    const result = detectNativeSearch('gemini-2.0-flash', 'google', provider);
    expect(result).toEqual({ supported: true, nativeProvider: 'google' });
  });

  it('detects OpenRouter by base URL', () => {
    const provider = makeProvider({ api_base_url: 'https://openrouter.ai/api/v1' });
    const result = detectNativeSearch('any-model', 'openai', provider);
    expect(result).toEqual({ supported: true, nativeProvider: 'openrouter' });
  });

  it('detects xAI by base URL', () => {
    const provider = makeProvider({ api_base_url: 'https://api.x.ai/v1' });
    const result = detectNativeSearch('grok-2', 'openai', provider);
    expect(result).toEqual({ supported: true, nativeProvider: 'xai' });
  });

  it('returns unsupported for unknown models', () => {
    const result = detectNativeSearch('llama-3.1-70b', 'openai', makeProvider());
    expect(result).toEqual({ supported: false, nativeProvider: null });
  });

  it('returns unsupported for unknown models without userExplicit', () => {
    const result = detectNativeSearch('deepseek-chat', 'openai', makeProvider(), false);
    expect(result).toEqual({ supported: false, nativeProvider: null });
  });

  it('falls back to API format when userExplicit is true', () => {
    // 'openai-response' maps to the 'openai' native provider; with userExplicit
    // the unknown model is trusted to support it.
    const result = detectNativeSearch('deepseek-chat', 'openai-response', makeProvider(), true);
    expect(result).toEqual({ supported: true, nativeProvider: 'openai' });
  });

  it('falls back to anthropic format when userExplicit is true', () => {
    const provider = makeProvider({ api_base_url: 'https://api.anthropic.com' });
    const result = detectNativeSearch('my-custom-claude', 'anthropic', provider, true);
    expect(result).toEqual({ supported: true, nativeProvider: 'anthropic' });
  });

  it('falls back to google format when userExplicit is true', () => {
    const provider = makeProvider({ api_base_url: 'https://generativelanguage.googleapis.com' });
    const result = detectNativeSearch('custom-gemini', 'google', provider, true);
    expect(result).toEqual({ supported: true, nativeProvider: 'google' });
  });

  it('still returns unsupported for unmapped format even with userExplicit', () => {
    // 'openai' (Chat Completions) and 'azure-openai' are NOT in
    // API_FORMAT_PROVIDER_MAP, so even userExplicit cannot pick a native
    // provider for them.
    const result = detectNativeSearch('some-model', 'azure-openai', makeProvider(), true);
    expect(result).toEqual({ supported: false, nativeProvider: null });
  });
});

// ============================================================
// buildNativeSearchAugmentation
// ============================================================

describe('buildNativeSearchAugmentation', () => {
  it('returns null when config is disabled', () => {
    const result = buildNativeSearchAugmentation('openai', { enabled: false }, 'openai', 'gpt-4o');
    expect(result).toBeNull();
  });

  describe('OpenAI', () => {
    it('builds web_search tool for Response API models', () => {
      const result = buildNativeSearchAugmentation('openai', defaultConfig, 'openai', 'gpt-4o');
      expect(result).not.toBeNull();
      expect(result!.additionalTools).toHaveLength(1);
      expect(result!.additionalTools![0]).toEqual({
        type: 'web_search',
        web_search: { search_context_size: 'medium' },
      });
    });

    it('builds web_search_options body field for search-preview models', () => {
      const result = buildNativeSearchAugmentation(
        'openai', defaultConfig, 'openai', 'gpt-4o-search-preview'
      );
      expect(result).not.toBeNull();
      expect(result!.additionalTools).toBeUndefined();
      expect(result!.bodyFields).toEqual({
        web_search_options: { search_context_size: 'medium' },
      });
    });

    it('maps low maxResults to low context size', () => {
      const result = buildNativeSearchAugmentation(
        'openai', { enabled: true, maxResults: 1 }, 'openai', 'gpt-4o'
      );
      const tool = result!.additionalTools![0] as Record<string, unknown>;
      expect((tool.web_search as Record<string, unknown>).search_context_size).toBe('low');
    });

    it('maps high maxResults to high context size', () => {
      const result = buildNativeSearchAugmentation(
        'openai', { enabled: true, maxResults: 10 }, 'openai', 'gpt-4o'
      );
      const tool = result!.additionalTools![0] as Record<string, unknown>;
      expect((tool.web_search as Record<string, unknown>).search_context_size).toBe('high');
    });
  });

  describe('Anthropic', () => {
    it('builds web_search_20250305 tool', () => {
      const result = buildNativeSearchAugmentation('anthropic', defaultConfig, 'anthropic', 'claude-3-5-sonnet');
      expect(result).not.toBeNull();
      expect(result!.additionalTools).toHaveLength(1);
      expect(result!.additionalTools![0]).toMatchObject({
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 5,
      });
    });

    it('includes blocked_domains when configured', () => {
      const config: NativeSearchUserConfig = {
        enabled: true,
        maxResults: 3,
        blockedDomains: ['example.com', 'spam.org'],
      };
      const result = buildNativeSearchAugmentation('anthropic', config, 'anthropic', 'claude-3-5-sonnet');
      const tool = result!.additionalTools![0] as Record<string, unknown>;
      expect(tool.blocked_domains).toEqual(['example.com', 'spam.org']);
    });
  });

  describe('Google', () => {
    it('builds google_search tool for Gemini 2.0+ models', () => {
      const result = buildNativeSearchAugmentation('google', defaultConfig, 'google', 'gemini-2.0-flash');
      expect(result).not.toBeNull();
      expect(result!.additionalTools).toHaveLength(1);
      expect(result!.additionalTools![0]).toEqual({ google_search: {} });
    });

    it('builds google_search tool for Gemini 3.x models', () => {
      const result = buildNativeSearchAugmentation('google', defaultConfig, 'google', 'gemini-3-flash');
      expect(result).not.toBeNull();
      expect(result!.additionalTools).toHaveLength(1);
      expect(result!.additionalTools![0]).toEqual({ google_search: {} });
    });

    it('builds googleSearchRetrieval tool for legacy Gemini 1.5 models', () => {
      const result = buildNativeSearchAugmentation('google', defaultConfig, 'google', 'gemini-1.5-flash');
      expect(result).not.toBeNull();
      expect(result!.additionalTools).toHaveLength(1);
      expect(result!.additionalTools![0]).toEqual({ googleSearchRetrieval: {} });
    });
  });

  describe('xAI', () => {
    it('builds search_parameters body field', () => {
      const result = buildNativeSearchAugmentation('xai', defaultConfig, 'openai', 'grok-2');
      expect(result).not.toBeNull();
      expect(result!.bodyFields).toEqual({
        search_parameters: {
          mode: 'auto',
          return_citations: true,
          max_search_results: 5,
        },
      });
    });

    it('respects custom searchMode and sources', () => {
      const config: NativeSearchUserConfig = {
        enabled: true,
        searchMode: 'on',
        sources: [{ type: 'web' }, { type: 'x' }],
      };
      const result = buildNativeSearchAugmentation('xai', config, 'openai', 'grok-2');
      expect(result!.bodyFields!.search_parameters).toMatchObject({
        mode: 'on',
        sources: [{ type: 'web' }, { type: 'x' }],
      });
    });
  });

  describe('OpenRouter', () => {
    it('builds plugins body field', () => {
      const result = buildNativeSearchAugmentation('openrouter', defaultConfig, 'openai', 'any-model');
      expect(result).not.toBeNull();
      expect(result!.bodyFields).toEqual({
        plugins: [{ id: 'web', max_results: 5 }],
      });
    });
  });
});

// ============================================================
// applyAugmentation
// ============================================================

describe('applyAugmentation', () => {
  it('appends tools to existing tools array', () => {
    const body: Record<string, unknown> = {
      model: 'gpt-4o',
      tools: [{ type: 'function', function: { name: 'test' } }],
    };
    applyAugmentation(body, {
      additionalTools: [{ type: 'web_search', web_search: {} }],
    });
    expect((body.tools as unknown[]).length).toBe(2);
  });

  it('creates tools array when none exists', () => {
    const body: Record<string, unknown> = { model: 'gpt-4o' };
    applyAugmentation(body, {
      additionalTools: [{ type: 'web_search', web_search: {} }],
    });
    expect((body.tools as unknown[]).length).toBe(1);
  });

  it('merges bodyFields into top-level', () => {
    const body: Record<string, unknown> = { model: 'grok-2' };
    applyAugmentation(body, {
      bodyFields: { search_parameters: { mode: 'auto' } },
    });
    expect(body.search_parameters).toEqual({ mode: 'auto' });
  });

  it('handles both additionalTools and bodyFields', () => {
    const body: Record<string, unknown> = { model: 'test' };
    applyAugmentation(body, {
      additionalTools: [{ type: 'web_search' }],
      bodyFields: { extra: 'field' },
    });
    expect((body.tools as unknown[]).length).toBe(1);
    expect(body.extra).toBe('field');
  });

  it('returns the same reference', () => {
    const body: Record<string, unknown> = {};
    const result = applyAugmentation(body, { bodyFields: { a: 1 } });
    expect(result).toBe(body);
  });
});
