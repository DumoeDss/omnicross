/**
 * CopilotAllowanceCollector.test.ts — the `copilot_internal/user` quota parse
 * (premium monthly window, unlimited handling, legacy chat window) plus the
 * collector's probe behavior and the 401 path (a revoked ghu_ token marks the
 * account expired — there is no refresh to succeed).
 */

import { describe, expect, it, vi } from 'vitest';

import type { CopilotTokenConfig, SubscriptionAccountEntry } from '@omnicross/contracts/account-tokens-types';
import { AccountAllowanceStore } from '@omnicross/core/pipeline/AccountAllowanceStore';

import { CopilotAllowanceCollector, parseCopilotUserPayload } from '../CopilotAllowanceCollector';

const NOW = Date.parse('2026-09-07T00:00:00.000Z');

describe('parseCopilotUserPayload', () => {
  function payload(snapshots: Record<string, unknown>, resetDate = '2026-10-01T00:00:00Z') {
    return { quota_snapshots: snapshots, quota_reset_date: resetDate };
  }

  it('maps premium_interactions to a monthly window preferring absolute meters', () => {
    const windows = parseCopilotUserPayload(payload({
      premium_interactions: { entitlement: 300, remaining: 45, percent_remaining: 15, unlimited: false },
    }), NOW)!;
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      id: 'thirty-day',
      usedPercent: 85,
      resetsAt: '2026-10-01T00:00:00.000Z',
      state: 'fresh',
    });
  });

  it('reports unlimited entitlements as 0% (never blocks) and adds the legacy chat window when metered', () => {
    const windows = parseCopilotUserPayload(payload({
      premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true },
      chat: { entitlement: 50, remaining: 10, percent_remaining: 20, unlimited: false },
    }), NOW)!;
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ id: 'thirty-day', usedPercent: 0 });
    expect(windows[1]).toMatchObject({ id: 'chat-monthly', usedPercent: 80 });
  });

  it('returns null without usable quota snapshots', () => {
    expect(parseCopilotUserPayload({}, NOW)).toBeNull();
    expect(parseCopilotUserPayload({ quota_snapshots: {} }, NOW)).toBeNull();
    expect(parseCopilotUserPayload({ quota_snapshots: { premium_interactions: { entitlement: 1 } } }, NOW)).toBeNull();
  });
});

function copilotAccount(overrides: Partial<CopilotTokenConfig> = {}): SubscriptionAccountEntry<CopilotTokenConfig> {
  return { id: 'acct-1', tokens: { authMethod: 'oauth', status: 'authorized', ...overrides } };
}

describe('CopilotAllowanceCollector', () => {
  function build(responses: Response[]) {
    const fetchImpl = vi.fn(async (url: string) => {
      const next = responses.shift();
      if (!next) throw new Error('no more canned responses');
      return next;
    });
    const refreshAccountToken = vi.fn(async () => false); // revoked ghu_ → refresh "fails"
    const getAccessTokenForAccount = vi.fn(async () => 'ghu_1');
    const store = new AccountAllowanceStore();
    const collector = new CopilotAllowanceCollector(
      { getAccessTokenForAccount, refreshAccountToken },
      store,
      fetchImpl as unknown as never,
      () => NOW,
    );
    return { collector, fetchImpl, refreshAccountToken, store };
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  it('probes the internal user endpoint and serves the monthly window', async () => {
    const { collector, fetchImpl } = build([json({
      quota_snapshots: {
        premium_interactions: { entitlement: 300, remaining: 150, percent_remaining: 50, unlimited: false },
      },
      quota_reset_date: '2026-10-01T00:00:00Z',
    })]);
    const snapshot = await collector.collect(copilotAccount(), { force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('api.github.com/copilot_internal/user');
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghu_1');
    expect((init.headers as Record<string, string>)['User-Agent']).toContain('copilot/');
    expect(snapshot.windows[0]).toMatchObject({ id: 'thirty-day', usedPercent: 50 });
  });

  it('routes the probe through the GHE api host when enterpriseUrl is set', async () => {
    const { collector, fetchImpl } = build([json({
      quota_snapshots: { premium_interactions: { entitlement: 10, remaining: 5, percent_remaining: 50, unlimited: false } },
      quota_reset_date: '2026-10-01T00:00:00Z',
    })]);
    await collector.collect(copilotAccount({ enterpriseUrl: 'company.ghe.com' }), { force: true });
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('https://api.company.ghe.com/copilot_internal/user');
  });

  it('a 401 (revoked token) does not loop: refresh declines and the snapshot degrades', async () => {
    const { collector, refreshAccountToken } = build([json({ error: 'bad token' }, 401)]);
    const snapshot = await collector.collect(copilotAccount(), { force: true });
    expect(refreshAccountToken).toHaveBeenCalledWith('copilot', 'acct-1');
    expect(snapshot.lastErrorCode).toBe('copilot_usage_unauthorized');
    expect(snapshot.windows[0]).toMatchObject({ state: 'unavailable' });
  });
});
