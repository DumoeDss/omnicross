/**
 * AuthStrategy tests — applyHeaders + onUnauthorized for each strategy type.
 */

import { describe, expect, it, vi } from 'vitest';

import type { SubscriptionCredentialStore } from '../../ports/credential-store';
import { OAuthBearerAuthStrategy } from '../OAuthBearerAuthStrategy';
import { PassThroughAuthStrategy } from '../PassThroughAuthStrategy';
import { RefreshMutex } from '../RefreshMutex';
import { StaticBearerAuthStrategy } from '../StaticBearerAuthStrategy';

function makeTokens(overrides: Partial<SubscriptionCredentialStore> = {}): SubscriptionCredentialStore {
  const base: Partial<SubscriptionCredentialStore> = {
    getFullConfig: vi.fn().mockResolvedValue({ updatedAt: '' }),
    getValidClaudeAccessToken: vi.fn().mockResolvedValue(null),
    getValidOpenCodeGoApiKey: vi.fn().mockResolvedValue(null),
    refreshClaudeToken: vi.fn().mockResolvedValue(false),
    refreshCodexToken: vi.fn().mockResolvedValue(false),
    refreshGeminiToken: vi.fn().mockResolvedValue(false),
  };
  return { ...base, ...overrides } as SubscriptionCredentialStore;
}

describe('PassThroughAuthStrategy', () => {
  it('applyHeaders injects the claude OAuth Bearer when a managed token exists (route-to path)', async () => {
    // The route-to path (Codex CLI → Claude subscription) is the ONLY caller of
    // applyHeaders; it needs a real Bearer because there is no SDK-forwarded
    // credential to reuse. The MAIN verbatim pass-through never calls this.
    const tokens = makeTokens({
      getValidClaudeAccessToken: vi.fn().mockResolvedValue('claude-oauth-tok'),
    });
    const strategy = new PassThroughAuthStrategy(tokens, new RefreshMutex<boolean>());
    const headers: Record<string, string> = {};
    await strategy.applyHeaders(headers);
    expect(headers['Authorization']).toBe('Bearer claude-oauth-tok');
  });

  it('applyHeaders is inert when no managed claude token exists (surface upstream 401)', async () => {
    const tokens = makeTokens({
      getValidClaudeAccessToken: vi.fn().mockResolvedValue(null),
    });
    const strategy = new PassThroughAuthStrategy(tokens, new RefreshMutex<boolean>());
    const headers: Record<string, string> = {};
    await strategy.applyHeaders(headers);
    expect(headers).toEqual({});
  });

  it('onUnauthorized triggers refreshClaudeToken', async () => {
    const refreshClaudeToken = vi.fn().mockResolvedValue(true);
    const tokens = makeTokens({ refreshClaudeToken });
    const strategy = new PassThroughAuthStrategy(tokens, new RefreshMutex<boolean>());
    const ok = await strategy.onUnauthorized();
    expect(ok).toBe(true);
    expect(refreshClaudeToken).toHaveBeenCalledTimes(1);
  });

  it('describeStatus reports missing-credential when no token', async () => {
    const tokens = makeTokens({
      getFullConfig: vi.fn().mockResolvedValue({ updatedAt: '' }),
    });
    const strategy = new PassThroughAuthStrategy(tokens, new RefreshMutex<boolean>());
    const status = await strategy.describeStatus();
    expect(status.ok).toBe(false);
    expect(status.reason).toBe('missing-credential');
  });
});

describe('OAuthBearerAuthStrategy', () => {
  it('applies Bearer token from stored config', async () => {
    const tokens = makeTokens({
      getFullConfig: vi.fn().mockResolvedValue({
        updatedAt: '',
        codex: {
          authMethod: 'oauth',
          status: 'authorized',
          accessToken: 'tok-codex',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      }),
    });
    const strategy = new OAuthBearerAuthStrategy('codex', tokens, new RefreshMutex<boolean>());
    const headers: Record<string, string> = {};
    await strategy.applyHeaders(headers);
    expect(headers['Authorization']).toBe('Bearer tok-codex');
  });

  it('refreshes when token is within the lead window', async () => {
    const refreshCodexToken = vi.fn().mockResolvedValue(true);
    const getFullConfig = vi.fn()
      // first call: token is about to expire
      .mockResolvedValueOnce({
        updatedAt: '',
        codex: {
          authMethod: 'oauth',
          status: 'authorized',
          accessToken: 'old-tok',
          refreshToken: 'rt',
          expiresAt: new Date(Date.now() + 1000).toISOString(), // < 60s
        },
      })
      // second call (after refresh): new token
      .mockResolvedValueOnce({
        updatedAt: '',
        codex: {
          authMethod: 'oauth',
          status: 'authorized',
          accessToken: 'new-tok',
          refreshToken: 'rt',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    const tokens = makeTokens({ getFullConfig, refreshCodexToken });
    const strategy = new OAuthBearerAuthStrategy('codex', tokens, new RefreshMutex<boolean>());
    const headers: Record<string, string> = {};
    await strategy.applyHeaders(headers);
    expect(refreshCodexToken).toHaveBeenCalled();
    expect(headers['Authorization']).toBe('Bearer new-tok');
  });

  it('onUnauthorized triggers refreshGeminiToken for gemini provider', async () => {
    const refreshGeminiToken = vi.fn().mockResolvedValue(true);
    const tokens = makeTokens({ refreshGeminiToken });
    const strategy = new OAuthBearerAuthStrategy('gemini', tokens, new RefreshMutex<boolean>());
    const ok = await strategy.onUnauthorized();
    expect(ok).toBe(true);
    expect(refreshGeminiToken).toHaveBeenCalledTimes(1);
  });

  it('concurrent onUnauthorized calls dedupe the refresh', async () => {
    let refreshCount = 0;
    const refreshCodexToken = vi.fn().mockImplementation(async () => {
      refreshCount++;
      await new Promise((r) => { setTimeout(r, 10); });
      return true;
    });
    const tokens = makeTokens({ refreshCodexToken });
    const mutex = new RefreshMutex<boolean>();
    const strategy = new OAuthBearerAuthStrategy('codex', tokens, mutex);
    await Promise.all([
      strategy.onUnauthorized(),
      strategy.onUnauthorized(),
      strategy.onUnauthorized(),
    ]);
    expect(refreshCount).toBe(1);
  });
});

describe('StaticBearerAuthStrategy', () => {
  it('applies Bearer key from stored config', async () => {
    const tokens = makeTokens({
      getValidOpenCodeGoApiKey: vi.fn().mockResolvedValue('oc-key-123'),
    });
    const strategy = new StaticBearerAuthStrategy(tokens);
    const headers: Record<string, string> = {};
    await strategy.applyHeaders(headers, { upstreamUrl: 'https://opencode.ai/zen/go/v1/chat/completions', resolvedModel: 'kimi-k2.6' });
    expect(headers['Authorization']).toBe('Bearer oc-key-123');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('adds x-api-key for Anthropic-shape upstream URLs', async () => {
    const tokens = makeTokens({
      getValidOpenCodeGoApiKey: vi.fn().mockResolvedValue('oc-key-123'),
    });
    const strategy = new StaticBearerAuthStrategy(tokens);
    const headers: Record<string, string> = {};
    await strategy.applyHeaders(headers, { upstreamUrl: 'https://opencode.ai/zen/go/v1/messages', resolvedModel: 'minimax-m2.5' });
    expect(headers['Authorization']).toBe('Bearer oc-key-123');
    expect(headers['x-api-key']).toBe('oc-key-123');
  });

  it('onUnauthorized always returns false (no refresh affordance)', async () => {
    const tokens = makeTokens();
    const strategy = new StaticBearerAuthStrategy(tokens);
    expect(await strategy.onUnauthorized()).toBe(false);
  });
});
