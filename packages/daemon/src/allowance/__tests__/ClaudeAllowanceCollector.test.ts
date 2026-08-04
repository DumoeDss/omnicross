import type { ClaudeTokenConfig, SubscriptionAccountEntry } from '@omnicross/contracts/account-tokens-types';
import { AccountAllowanceStore } from '@omnicross/core/pipeline/AccountAllowanceStore';
import { SubscriptionIdentityStore } from '@omnicross/core/provider-proxy/identity/SubscriptionIdentityStore';
import { describe, expect, it, vi } from 'vitest';

import {
  CLAUDE_ALLOWANCE_CACHE_MS,
  ClaudeAllowanceCollector,
  type ClaudeAllowanceCredentialReader,
} from '../ClaudeAllowanceCollector';

function account(
  id: string,
  tokens: Partial<ClaudeTokenConfig> = {},
): SubscriptionAccountEntry<ClaudeTokenConfig> {
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

function credentials(overrides: Partial<ClaudeAllowanceCredentialReader> = {}): ClaudeAllowanceCredentialReader {
  return {
    getAccessTokenForAccount: vi.fn(async (_provider, id) => `access-${id}`),
    refreshAccountToken: vi.fn(async () => true),
    ...overrides,
  };
}

function usageResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    five_hour: { utilization: 41, resets_at: '2026-08-03T05:00:00.000Z' },
    seven_day: { utilization: 22, resets_at: '2026-08-10T00:00:00.000Z' },
    seven_day_sonnet: { utilization: 9, resets_at: '2026-08-10T00:00:00.000Z' },
    ...overrides,
  });
}

describe('ClaudeAllowanceCollector', () => {
  it('normalizes five-hour, seven-day, and Sonnet windows without exposing credentials', async () => {
    const now = Date.parse('2026-08-03T00:00:00.000Z');
    const fetchImpl = vi.fn(async () => usageResponse());
    const collector = new ClaudeAllowanceCollector(
      credentials(),
      new AccountAllowanceStore(() => now),
      fetchImpl,
      new SubscriptionIdentityStore(),
      () => now,
    );

    const snapshot = await collector.collect(account('claude-a'));
    expect(snapshot).toMatchObject({
      providerId: 'claude',
      accountId: 'claude-a',
      source: 'oauth-usage-api',
      observedAt: '2026-08-03T00:00:00.000Z',
      windows: [
        { id: 'five-hour', usedPercent: 41, windowMinutes: 300, state: 'fresh' },
        { id: 'seven-day', usedPercent: 22, windowMinutes: 10080, state: 'fresh' },
        {
          id: 'seven-day-sonnet',
          usedPercent: 9,
          modelFamily: 'sonnet',
          state: 'fresh',
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain('access-claude-a');
    expect(JSON.stringify(snapshot)).not.toContain('Authorization');

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-claude-a');
  });

  it('projects out-of-range utilization as unavailable instead of dropping the account row', async () => {
    const now = Date.parse('2026-08-03T00:00:00.000Z');
    const collector = new ClaudeAllowanceCollector(
      credentials(),
      new AccountAllowanceStore(() => now),
      vi.fn(async () => usageResponse({
        five_hour: { utilization: 101 },
        seven_day: { utilization: -1 },
        seven_day_sonnet: { utilization: 'not-a-percent' },
      })),
      new SubscriptionIdentityStore(),
      () => now,
    );

    const snapshot = await collector.collect(account('claude-invalid'));
    expect(snapshot.windows.every((window) => window.usedPercent === null)).toBe(true);
    expect(snapshot.windows.every((window) => window.state === 'unavailable')).toBe(true);
  });

  it('coalesces concurrent collection and reuses the five-minute cache', async () => {
    let now = 1_000_000;
    let resolveFetch!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    const collector = new ClaudeAllowanceCollector(
      credentials(),
      new AccountAllowanceStore(() => now),
      fetchImpl,
      new SubscriptionIdentityStore(),
      () => now,
    );
    const entry = account('claude-a');

    const first = collector.collect(entry);
    const concurrent = collector.collect(entry);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    resolveFetch(usageResponse());
    await Promise.all([first, concurrent]);

    await collector.collect(entry);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += CLAUDE_ALLOWANCE_CACHE_MS + 1;
    const expired = collector.collect(entry);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    resolveFetch(usageResponse({ five_hour: { utilization: 55 } }));
    expect((await expired).windows[0]?.usedPercent).toBe(55);
  });

  it('refreshes shortly before expiry only when a refresh-ahead window requests it', async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn(async () => usageResponse());
    const collector = new ClaudeAllowanceCollector(
      credentials(),
      new AccountAllowanceStore(() => now),
      fetchImpl,
      new SubscriptionIdentityStore(),
      () => now,
    );
    const entry = account('claude-a');

    await collector.collect(entry);
    now += CLAUDE_ALLOWANCE_CACHE_MS - 120_000;
    await collector.collect(entry, { refreshAheadMs: 90_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 30_001;
    await collector.collect(entry, { refreshAheadMs: 90_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    account('setup', { authMethod: 'setup_token', isSetupToken: true }),
    account('manual', { authMethod: 'manual' }),
  ])('marks unsupported auth without an upstream request ($id)', async (entry) => {
    const fetchImpl = vi.fn(async () => usageResponse());
    const collector = new ClaudeAllowanceCollector(
      credentials(),
      new AccountAllowanceStore(),
      fetchImpl,
      new SubscriptionIdentityStore(),
    );
    const snapshot = await collector.collect(entry);
    expect(snapshot.windows.every((window) => window.state === 'unsupported')).toBe(true);
    expect(snapshot.lastErrorCode).toBe('claude_usage_unsupported_auth');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refreshes and retries the same account once after a 401', async () => {
    const tokenReader = vi.fn()
      .mockResolvedValueOnce('old-token')
      .mockResolvedValueOnce('new-token');
    const refresh = vi.fn(async () => true);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(usageResponse());
    const collector = new ClaudeAllowanceCollector(
      credentials({ getAccessTokenForAccount: tokenReader, refreshAccountToken: refresh }),
      new AccountAllowanceStore(),
      fetchImpl,
      new SubscriptionIdentityStore(),
    );

    const snapshot = await collector.collect(account('selected-account'));
    expect(refresh).toHaveBeenCalledWith('claude', 'selected-account');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const retryHeaders = fetchImpl.mock.calls[1]?.[1].headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer new-token');
    expect(snapshot.accountId).toBe('selected-account');
  });

  it('isolates one account failure during a multi-account collection', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit, accountId: string) => {
      if (accountId === 'bad') throw new Error('sensitive upstream detail');
      return usageResponse();
    });
    const collector = new ClaudeAllowanceCollector(
      credentials(),
      new AccountAllowanceStore(),
      fetchImpl,
      new SubscriptionIdentityStore(),
    );

    const snapshots = await collector.collectMany([account('good'), account('bad')]);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.find((item) => item.accountId === 'good')?.windows[0]?.state).toBe('fresh');
    const failed = snapshots.find((item) => item.accountId === 'bad');
    expect(failed?.windows.every((window) => window.state === 'unavailable')).toBe(true);
    expect(failed?.lastErrorCode).toBe('claude_usage_request_failed');
    expect(JSON.stringify(failed)).not.toContain('sensitive upstream detail');
  });
});
