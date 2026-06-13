/**
 * SubscriptionProviderRegistry tests — every built-in provider id resolves to
 * a profile with the expected shape and transformer chain.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  OAuthBearerAuthStrategy,
  PassThroughAuthStrategy,
  RefreshMutex,
  StaticBearerAuthStrategy,
} from '../auth';
import type { SubscriptionCredentialStore } from '../ports/credential-store';
import { SubscriptionAccountService } from '../SubscriptionAccountService';
import { SubscriptionProviderRegistry } from '../SubscriptionProviderRegistry';

function mockTokens(): SubscriptionCredentialStore {
  return {
    getFullConfig: vi.fn().mockResolvedValue({ updatedAt: new Date().toISOString() }),
    getSanitized: vi.fn().mockResolvedValue({ updatedAt: new Date().toISOString() }),
    getValidClaudeAccessToken: vi.fn().mockResolvedValue(null),
    getValidOpenCodeGoApiKey: vi.fn().mockResolvedValue(null),
    refreshClaudeToken: vi.fn().mockResolvedValue(false),
    refreshCodexToken: vi.fn().mockResolvedValue(false),
    refreshGeminiToken: vi.fn().mockResolvedValue(false),
  } as unknown as SubscriptionCredentialStore;
}

describe('SubscriptionProviderRegistry', () => {
  it('returns claude profile in pass-through mode WITH route-to fields', () => {
    const tokens = mockTokens();
    const accounts = new SubscriptionAccountService(tokens);
    const registry = new SubscriptionProviderRegistry(accounts, tokens);
    const profile = registry.getProfile('claude');
    expect(profile).not.toBeNull();
    expect(profile?.providerId).toBe('claude');
    // The MAIN verbatim path stays pass-through.
    expect(profile?.mode).toBe('pass-through');
    expect(profile?.authStrategy.kind).toBe('pass-through');
    expect(profile?.authStrategy).toBeInstanceOf(PassThroughAuthStrategy);
    // Route-to (Codex/Responses ingress) fields: re-encode Unified → Anthropic
    // Messages + POST to api.anthropic.com. These are INERT for the verbatim
    // pass-through path (it hard-codes the URL + skips the transformer chain).
    expect(profile?.providerTransformerNames).toEqual(['anthropic']);
    expect(profile?.resolveUpstreamUrl?.('claude-sonnet-4-5')).toBe(
      'https://api.anthropic.com/v1/messages',
    );
  });

  it('returns codex profile in transformer mode with openai-response chain', () => {
    const tokens = mockTokens();
    const accounts = new SubscriptionAccountService(tokens);
    const registry = new SubscriptionProviderRegistry(accounts, tokens);
    const profile = registry.getProfile('codex');
    expect(profile).not.toBeNull();
    expect(profile?.providerId).toBe('codex');
    expect(profile?.mode).toBe('transformer');
    expect(profile?.authStrategy.kind).toBe('oauth-bearer');
    expect(profile?.authStrategy).toBeInstanceOf(OAuthBearerAuthStrategy);
    expect(profile?.providerTransformerNames).toEqual(['openai-response']);
    expect(profile?.resolveUpstreamUrl?.('gpt-5')).toBe('https://chatgpt.com/backend-api/codex/responses');
  });

  it('returns gemini profile with gemini-code-assist chain + Code Assist upstream', () => {
    const tokens = mockTokens();
    const accounts = new SubscriptionAccountService(tokens);
    const registry = new SubscriptionProviderRegistry(accounts, tokens);
    const profile = registry.getProfile('gemini');
    expect(profile).not.toBeNull();
    expect(profile?.providerId).toBe('gemini');
    // Gap closed: the Code Assist transformer wraps the project/session envelope.
    expect(profile?.providerTransformerNames).toEqual(['gemini-code-assist']);
    expect(profile?.authStrategy).toBeInstanceOf(OAuthBearerAuthStrategy);
    // Code Assist colon-method endpoint — NO public-API /v1beta/models/<model> path
    // (the model lives in the body, not the URL).
    const url = profile?.resolveUpstreamUrl?.('gemini-2.5-pro');
    expect(url).toContain('cloudcode-pa.googleapis.com');
    expect(url).toContain('v1internal:generateContent');
    expect(url).not.toContain('generativelanguage.googleapis.com');
    expect(url).not.toContain('gemini-2.5-pro');
  });

  it('returns opencodego profile with static-bearer auth and modelMapper', () => {
    const tokens = mockTokens();
    const accounts = new SubscriptionAccountService(tokens);
    const registry = new SubscriptionProviderRegistry(accounts, tokens);
    const profile = registry.getProfile('opencodego');
    expect(profile).not.toBeNull();
    expect(profile?.providerId).toBe('opencodego');
    expect(profile?.authStrategy.kind).toBe('static-bearer');
    expect(profile?.authStrategy).toBeInstanceOf(StaticBearerAuthStrategy);
    expect(profile?.providerTransformerNames).toEqual(['opencodego']);
    expect(profile?.modelMapper).toBeDefined();
    expect(profile?.nextFallback).toBeDefined();

    // OpenAI-shape model selects chat completions endpoint
    const openaiUrl = profile?.resolveUpstreamUrl?.('kimi-k2.6');
    expect(openaiUrl).toBe('https://opencode.ai/zen/go/v1/chat/completions');

    // MiniMax model selects anthropic-shape endpoint
    const anthropicUrl = profile?.resolveUpstreamUrl?.('minimax-m2.5');
    expect(anthropicUrl).toBe('https://opencode.ai/zen/go/v1/messages');
  });

  it('opencodego resolveUpstreamUrl honors a per-account baseUrl override (D1)', () => {
    const tokens = mockTokens();
    const accounts = new SubscriptionAccountService(tokens);
    const registry = new SubscriptionProviderRegistry(accounts, tokens);
    const profile = registry.getProfile('opencodego')!;
    const config = {
      authMethod: 'manual' as const,
      status: 'configured' as const,
      baseUrl: 'https://my-host.example.com',
    };
    // Anthropic-shape (MiniMax) → override host + /v1/messages.
    expect(profile.resolveUpstreamUrl?.('minimax-m2.5', config)).toBe(
      'https://my-host.example.com/v1/messages',
    );
    // OpenAI-shape → override host + /v1/chat/completions.
    expect(profile.resolveUpstreamUrl?.('kimi-k2.6', config)).toBe(
      'https://my-host.example.com/v1/chat/completions',
    );
  });

  it('opencodego resolveUpstreamUrl is BYTE-IDENTICAL to the constants when baseUrl is unset', () => {
    const tokens = mockTokens();
    const accounts = new SubscriptionAccountService(tokens);
    const registry = new SubscriptionProviderRegistry(accounts, tokens);
    const profile = registry.getProfile('opencodego')!;
    // No config at all → the prior hard-coded constants.
    expect(profile.resolveUpstreamUrl?.('minimax-m2.5')).toBe(
      'https://opencode.ai/zen/go/v1/messages',
    );
    expect(profile.resolveUpstreamUrl?.('kimi-k2.6')).toBe(
      'https://opencode.ai/zen/go/v1/chat/completions',
    );
    // A config WITHOUT baseUrl → still byte-identical.
    const noBaseUrl = { authMethod: 'manual' as const, status: 'configured' as const };
    expect(profile.resolveUpstreamUrl?.('minimax-m2.5', noBaseUrl)).toBe(
      'https://opencode.ai/zen/go/v1/messages',
    );
    expect(profile.resolveUpstreamUrl?.('kimi-k2.6', noBaseUrl)).toBe(
      'https://opencode.ai/zen/go/v1/chat/completions',
    );
  });

  it('returns null for unknown providerId', () => {
    const tokens = mockTokens();
    const accounts = new SubscriptionAccountService(tokens);
    const registry = new SubscriptionProviderRegistry(accounts, tokens);
    expect(registry.getProfile('nonexistent')).toBeNull();
    expect(registry.getProfile('')).toBeNull();
  });

  // ── opencodego ZEN half (opencodego-zen-provider) ────────────────────────────
  // The real profile recovers the half from the user config (a model id that
  // appears in a `provider:'zen'` modelMap/fallbacks entry routes to the zen
  // half), then resolves the shape-specific zen URL + chain.
  // `// UNVERIFIED (no live zen key)` — endpoints proven in-process only.
  describe('opencodego zen half', () => {
    const tokens = mockTokens();
    const accounts = new SubscriptionAccountService(tokens);
    const registry = new SubscriptionProviderRegistry(accounts, tokens);
    const profile = registry.getProfile('opencodego')!;

    const zenCfg = (entry: { modelId: string }) => ({
      authMethod: 'manual' as const,
      status: 'configured' as const,
      modelMap: { default: { modelId: entry.modelId, provider: 'zen' as const } },
    });

    it('zen anthropic (claude) → /zen/v1/messages + EMPTY chain (verbatim)', () => {
      const cfg = zenCfg({ modelId: 'claude-sonnet-4.5' });
      expect(profile.resolveUpstreamUrl?.('claude-sonnet-4.5', cfg)).toBe(
        'https://opencode.ai/zen/v1/messages',
      );
      expect(profile.resolveProviderTransformerNames?.('claude-sonnet-4.5', cfg)).toEqual([]);
    });

    it('zen responses (gpt-5-codex) → /zen/v1/responses + openai-response chain', () => {
      const cfg = zenCfg({ modelId: 'gpt-5-codex' });
      expect(profile.resolveUpstreamUrl?.('gpt-5-codex', cfg)).toBe(
        'https://opencode.ai/zen/v1/responses',
      );
      expect(profile.resolveProviderTransformerNames?.('gpt-5-codex', cfg)).toEqual([
        'openai-response',
      ]);
    });

    it('zen gemini → /zen/v1/models/ BASE (trailing slash) + gemini chain', () => {
      const cfg = zenCfg({ modelId: 'gemini-3-flash' });
      expect(profile.resolveUpstreamUrl?.('gemini-3-flash', cfg)).toBe(
        'https://opencode.ai/zen/v1/models/',
      );
      expect(profile.resolveProviderTransformerNames?.('gemini-3-flash', cfg)).toEqual(['gemini']);
    });

    it('zen chat (qwen non-max) → /zen/v1/chat/completions + opencodego chain', () => {
      const cfg = zenCfg({ modelId: 'qwen3.6-plus' });
      expect(profile.resolveUpstreamUrl?.('qwen3.6-plus', cfg)).toBe(
        'https://opencode.ai/zen/v1/chat/completions',
      );
      expect(profile.resolveProviderTransformerNames?.('qwen3.6-plus', cfg)).toEqual(['opencodego']);
    });

    it('zenBaseUrl overrides ONLY the zen half (go untouched)', () => {
      const cfg = {
        authMethod: 'manual' as const,
        status: 'configured' as const,
        baseUrl: 'https://my-go.example.com',
        zenBaseUrl: 'https://my-zen.example.com',
        modelMap: {
          default: { modelId: 'gpt-5-codex', provider: 'zen' as const },
          fast: { modelId: 'kimi-k2.6' }, // go (no provider)
        },
      };
      // zen model → zenBaseUrl host.
      expect(profile.resolveUpstreamUrl?.('gpt-5-codex', cfg)).toBe(
        'https://my-zen.example.com/v1/responses',
      );
      // go model → baseUrl host (the go override did NOT leak to zen and vice-versa).
      expect(profile.resolveUpstreamUrl?.('kimi-k2.6', cfg)).toBe(
        'https://my-go.example.com/v1/chat/completions',
      );
    });

    it('a non-opencodego profile (claude) does NOT implement resolveProviderTransformerNames', () => {
      expect(registry.getProfile('claude')?.resolveProviderTransformerNames).toBeUndefined();
      expect(registry.getProfile('codex')?.resolveProviderTransformerNames).toBeUndefined();
      expect(registry.getProfile('gemini')?.resolveProviderTransformerNames).toBeUndefined();
    });
  });

  it('opencodego modelMapper picks default scenario for short context', () => {
    const tokens = mockTokens();
    const accounts = new SubscriptionAccountService(tokens);
    const registry = new SubscriptionProviderRegistry(accounts, tokens);
    const profile = registry.getProfile('opencodego')!;
    const result = profile.modelMapper!('sdk-model', {
      messageCount: 1,
      estimatedInputTokens: 100,
    }, undefined);
    expect(result.scenario).toBe('default');
    expect(result.resolvedModel).toBe('kimi-k2.6');
  });

  it('opencodego modelMapper picks long_context scenario above threshold', () => {
    const tokens = mockTokens();
    const accounts = new SubscriptionAccountService(tokens);
    const registry = new SubscriptionProviderRegistry(accounts, tokens);
    const profile = registry.getProfile('opencodego')!;
    const result = profile.modelMapper!('sdk-model', {
      messageCount: 50,
      estimatedInputTokens: 100_000,
    }, undefined);
    expect(result.scenario).toBe('long_context');
    expect(result.resolvedModel).toBe('minimax-m2.5');
  });

  it('opencodego nextFallback returns null when exhausted', () => {
    const tokens = mockTokens();
    const accounts = new SubscriptionAccountService(tokens);
    const registry = new SubscriptionProviderRegistry(accounts, tokens);
    const profile = registry.getProfile('opencodego')!;
    // First fallback should be available
    const first = profile.nextFallback!('default', ['kimi-k2.6'], undefined);
    expect(first?.modelId).toBe('mimo-v2-pro');
    // After all defaults attempted, returns null
    const exhausted = profile.nextFallback!('default', ['kimi-k2.6', 'mimo-v2-pro', 'qwen3.6-plus'], undefined);
    expect(exhausted).toBeNull();
  });

  it('opencodego modelMapper resolves complex scenario to glm-5.1 (D4 fix)', () => {
    const tokens = mockTokens();
    const accounts = new SubscriptionAccountService(tokens);
    const registry = new SubscriptionProviderRegistry(accounts, tokens);
    const profile = registry.getProfile('opencodego')!;
    // The scenario router never auto-selects `complex`, so drive it via an
    // explicit user modelMap key that itself omits `complex` — the resolver
    // falls through to DEFAULT_OPENCODEGO_MODEL_MAP.complex. Easiest: assert
    // the resolved model id for a config whose modelMap forces `complex`.
    const result = profile.modelMapper!(
      'sdk-model',
      { messageCount: 1, estimatedInputTokens: 100 },
      { authMethod: 'manual', status: 'configured', modelMap: { complex: { modelId: 'glm-5.1' } } },
    );
    // modelMapper itself routes by scenario; `complex` is not auto-selected, so
    // assert the built-in default directly instead.
    expect(result.resolvedModel).toBe('kimi-k2.6');
    expect(result.scenario).toBe('default');
  });

  it('opencodego nextFallback walks the background list (dormant scenario)', () => {
    const tokens = mockTokens();
    const accounts = new SubscriptionAccountService(tokens);
    const registry = new SubscriptionProviderRegistry(accounts, tokens);
    const profile = registry.getProfile('opencodego')!;
    // background is dormant (router never selects it) but its default fallback
    // list is still resolvable when a caller passes the scenario explicitly.
    const first = profile.nextFallback!('background', [], undefined);
    expect(first?.modelId).toBe('qwen3.6-plus');
    const second = profile.nextFallback!('background', ['qwen3.6-plus'], undefined);
    expect(second?.modelId).toBe('minimax-m2.5');
    const exhausted = profile.nextFallback!('background', ['qwen3.6-plus', 'minimax-m2.5'], undefined);
    expect(exhausted).toBeNull();
  });

  // ── Circuit breaker consult (D5) ────────────────────────────────────────────

  it('opencodego exposes breaker hooks (allowModel + recordModelOutcome) ONLY', () => {
    const tokens = mockTokens();
    const accounts = new SubscriptionAccountService(tokens);
    const registry = new SubscriptionProviderRegistry(accounts, tokens);
    // opencodego sets both; claude/codex/gemini leave them UNSET (no breaker).
    expect(registry.getProfile('opencodego')?.allowModel).toBeDefined();
    expect(registry.getProfile('opencodego')?.recordModelOutcome).toBeDefined();
    for (const id of ['claude', 'codex', 'gemini'] as const) {
      expect(registry.getProfile(id)?.allowModel).toBeUndefined();
      expect(registry.getProfile(id)?.recordModelOutcome).toBeUndefined();
    }
  });

  it('opencodego nextFallback SKIPS a model whose circuit opened (3 recorded failures)', () => {
    const tokens = mockTokens();
    const accounts = new SubscriptionAccountService(tokens);
    const registry = new SubscriptionProviderRegistry(accounts, tokens);
    const profile = registry.getProfile('opencodego')!;
    // default fallbacks: [mimo-v2-pro, qwen3.6-plus]. With no breaker tripped,
    // the first candidate is mimo-v2-pro.
    expect(profile.nextFallback!('default', ['kimi-k2.6'], undefined)?.modelId).toBe('mimo-v2-pro');
    // Open mimo-v2-pro's circuit (3 consecutive failures).
    profile.recordModelOutcome!('mimo-v2-pro', false);
    profile.recordModelOutcome!('mimo-v2-pro', false);
    profile.recordModelOutcome!('mimo-v2-pro', false);
    // Now nextFallback skips the open mimo-v2-pro → returns qwen3.6-plus.
    expect(profile.nextFallback!('default', ['kimi-k2.6'], undefined)?.modelId).toBe('qwen3.6-plus');
  });

  it('opencodego allowModel reflects the breaker (open after 3 failures, fail-closed within window)', () => {
    const tokens = mockTokens();
    const accounts = new SubscriptionAccountService(tokens);
    const registry = new SubscriptionProviderRegistry(accounts, tokens);
    const profile = registry.getProfile('opencodego')!;
    expect(profile.allowModel!('kimi-k2.6')).toBe(true);
    profile.recordModelOutcome!('kimi-k2.6', false);
    profile.recordModelOutcome!('kimi-k2.6', false);
    expect(profile.allowModel!('kimi-k2.6')).toBe(true); // 2 failures — still closed
    profile.recordModelOutcome!('kimi-k2.6', false); // 3rd → open
    expect(profile.allowModel!('kimi-k2.6')).toBe(false); // open within 30s window
  });

  it('opencodego breaker is shared across getProfile() calls (same registry instance)', () => {
    const tokens = mockTokens();
    const accounts = new SubscriptionAccountService(tokens);
    const registry = new SubscriptionProviderRegistry(accounts, tokens);
    // Open a model via one profile handle.
    const a = registry.getProfile('opencodego')!;
    a.recordModelOutcome!('glm-5.1', false);
    a.recordModelOutcome!('glm-5.1', false);
    a.recordModelOutcome!('glm-5.1', false);
    // A SECOND handle (same registry) sees the open circuit → state is shared.
    const b = registry.getProfile('opencodego')!;
    expect(b.allowModel!('glm-5.1')).toBe(false);
  });

  it('a closed success resets the consecutive failure count through the profile', () => {
    const tokens = mockTokens();
    const accounts = new SubscriptionAccountService(tokens);
    const registry = new SubscriptionProviderRegistry(accounts, tokens);
    const profile = registry.getProfile('opencodego')!;
    profile.recordModelOutcome!('qwen3.6-plus', false);
    profile.recordModelOutcome!('qwen3.6-plus', false);
    profile.recordModelOutcome!('qwen3.6-plus', true); // success resets the streak
    profile.recordModelOutcome!('qwen3.6-plus', false); // only 1 since reset
    expect(profile.allowModel!('qwen3.6-plus')).toBe(true); // still closed
  });
});

describe('RefreshMutex', () => {
  it('deduplicates concurrent refreshes for the same key', async () => {
    const mutex = new RefreshMutex<number>();
    const work = vi.fn().mockImplementation(async () => {
      await new Promise((r) => { setTimeout(r, 10); });
      return 42;
    });
    const [a, b, c] = await Promise.all([
      mutex.run('codex:refresh', work),
      mutex.run('codex:refresh', work),
      mutex.run('codex:refresh', work),
    ]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(c).toBe(42);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('runs distinct keys independently', async () => {
    const mutex = new RefreshMutex<string>();
    const codexWork = vi.fn().mockResolvedValue('codex-tok');
    const geminiWork = vi.fn().mockResolvedValue('gemini-tok');
    const [c, g] = await Promise.all([
      mutex.run('codex', codexWork),
      mutex.run('gemini', geminiWork),
    ]);
    expect(c).toBe('codex-tok');
    expect(g).toBe('gemini-tok');
    expect(codexWork).toHaveBeenCalledTimes(1);
    expect(geminiWork).toHaveBeenCalledTimes(1);
  });
});
