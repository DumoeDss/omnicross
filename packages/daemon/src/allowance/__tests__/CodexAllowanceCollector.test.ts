import type { CodexTokenConfig, SubscriptionAccountEntry } from '@omnicross/contracts/account-tokens-types';
import { AccountAllowanceStore } from '@omnicross/core/pipeline/AccountAllowanceStore';
import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_ALLOWANCE_CACHE_MS,
  CodexAllowanceCollector,
  type CodexAllowanceCredentialReader,
  resolveCodexChatGptAccountId,
} from '../CodexAllowanceCollector';

function account(
  id: string,
  tokens: Partial<CodexTokenConfig> = {},
): SubscriptionAccountEntry<CodexTokenConfig> {
  return {
    id,
    label: id,
    tokens: {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: `secret-${id}`,
      ...tokens,
    },
  };
}

function credentials(overrides: Partial<CodexAllowanceCredentialReader> = {}): CodexAllowanceCredentialReader {
  return {
    getAccessTokenForAccount: vi.fn(async (_provider, id) => `access-${id}`),
    refreshAccountToken: vi.fn(async () => true),
    ...overrides,
  };
}

function base64urlJson(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function jwt(claims: Record<string, unknown>): string {
  return `header.${base64urlJson(claims)}.signature`;
}

const AUTH_CLAIM = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' } };

function usageResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    plan_type: 'pro',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 42,
        limit_window_seconds: 18000,
        reset_after_seconds: 6000,
        reset_at: 1785991200, // 2026-08-06T04:40:00Z — absolute, preferred
      },
      secondary_window: {
        used_percent: 12,
        limit_window_seconds: 604800,
        reset_after_seconds: 400000,
      },
    },
    ...overrides,
  });
}

describe('resolveCodexChatGptAccountId', () => {
  it('prefers the stored field, then the id_token claim, then the access token claim', () => {
    expect(resolveCodexChatGptAccountId({ authMethod: 'oauth', status: 'authorized', accountId: 'stored' }))
      .toBe('stored');
    expect(
      resolveCodexChatGptAccountId({
        authMethod: 'oauth',
        status: 'authorized',
        idToken: jwt(AUTH_CLAIM),
        accessToken: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'from-access' } }),
      }),
    ).toBe('acct-123');
    expect(
      resolveCodexChatGptAccountId({
        authMethod: 'oauth',
        status: 'authorized',
        accessToken: jwt(AUTH_CLAIM),
      }),
    ).toBe('acct-123');
    // A malformed access token (not a JWT) resolves to undefined, never a crash.
    expect(
      resolveCodexChatGptAccountId({ authMethod: 'oauth', status: 'authorized', accessToken: 'not-a-jwt' }),
    ).toBeUndefined();
  });
});

describe('CodexAllowanceCollector', () => {
  it('normalizes the wham usage windows preferring the absolute reset_at', async () => {
    const now = Date.parse('2026-08-03T00:00:00.000Z');
    const fetchImpl = vi.fn(async () => usageResponse());
    const collector = new CodexAllowanceCollector(
      credentials(),
      new AccountAllowanceStore(() => now),
      fetchImpl,
      () => now,
    );

    const snapshot = await collector.collect(account('codex-a', { idToken: jwt(AUTH_CLAIM) }));
    expect(snapshot).toMatchObject({
      providerId: 'codex',
      accountId: 'codex-a',
      source: 'oauth-usage-api',
      windows: [
        {
          id: 'primary',
          usedPercent: 42,
          windowMinutes: 300,
          resetsAt: '2026-08-06T04:40:00.000Z',
          state: 'fresh',
        },
        {
          id: 'secondary',
          usedPercent: 12,
          windowMinutes: 10080,
          state: 'fresh',
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain('access-codex-a');

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer access-codex-a');
    expect(headers['ChatGPT-Account-Id']).toBe('acct-123');
  });

  it('falls back to reset_after_seconds projection when reset_at is absent', async () => {
    const now = Date.parse('2026-08-03T00:00:00.000Z');
    const collector = new CodexAllowanceCollector(
      credentials(),
      new AccountAllowanceStore(() => now),
      vi.fn(async () => usageResponse({
        rate_limit: {
          primary_window: { used_percent: 5, reset_after_seconds: 120, limit_window_seconds: 18000 },
          secondary_window: null,
        },
      })),
      () => now,
    );

    const snapshot = await collector.collect(account('codex-a'));
    expect(snapshot.windows).toMatchObject([
      { id: 'primary', resetsAt: '2026-08-03T00:02:00.000Z' },
      { id: 'secondary', usedPercent: null, state: 'unavailable' },
    ]);
  });

  it('refreshes and retries once after a 401, and marks 403 unsupported', async () => {
    const tokenReader = vi.fn()
      .mockResolvedValueOnce('old-token')
      .mockResolvedValueOnce('new-token');
    const refresh = vi.fn(async () => true);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(usageResponse());
    const collector = new CodexAllowanceCollector(
      credentials({ getAccessTokenForAccount: tokenReader, refreshAccountToken: refresh }),
      new AccountAllowanceStore(),
      fetchImpl,
    );

    const snapshot = await collector.collect(account('selected-account'));
    expect(refresh).toHaveBeenCalledWith('codex', 'selected-account');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(snapshot.accountId).toBe('selected-account');
    expect(snapshot.windows[0]?.state).toBe('fresh');

    const forbidden = new CodexAllowanceCollector(
      credentials(),
      new AccountAllowanceStore(),
      vi.fn(async () => new Response('', { status: 403 })),
    );
    const unsupported = await forbidden.collect(account('forbidden'));
    expect(unsupported.windows.every((window) => window.state === 'unsupported')).toBe(true);
    expect(unsupported.lastErrorCode).toBe('codex_usage_unsupported');
  });

  it('caches for five minutes and coalesces concurrent collections', async () => {
    let now = 1_000_000;
    let resolveFetch!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    const collector = new CodexAllowanceCollector(
      credentials(),
      new AccountAllowanceStore(() => now),
      fetchImpl,
      () => now,
    );
    const entry = account('codex-a');

    const first = collector.collect(entry);
    const concurrent = collector.collect(entry);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    resolveFetch(usageResponse());
    await Promise.all([first, concurrent]);

    await collector.collect(entry);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += CODEX_ALLOWANCE_CACHE_MS + 1;
    const expired = collector.collect(entry);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    resolveFetch(usageResponse({
      rate_limit: { primary_window: { used_percent: 55 }, secondary_window: null },
    }));
    expect((await expired).windows[0]?.usedPercent).toBe(55);
  });

  it('marks manual (non-oauth) accounts unsupported without an upstream request', async () => {
    const fetchImpl = vi.fn(async () => usageResponse());
    const collector = new CodexAllowanceCollector(
      credentials(),
      new AccountAllowanceStore(),
      fetchImpl,
    );
    const snapshot = await collector.collect(account('manual', { authMethod: 'manual' }));
    expect(snapshot.windows.every((window) => window.state === 'unsupported')).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
