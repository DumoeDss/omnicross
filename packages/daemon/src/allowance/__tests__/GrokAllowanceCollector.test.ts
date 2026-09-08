/**
 * GrokAllowanceCollector.test.ts — the billing dual-shape parse (weekly
 * credits / unified monthly) incl. the inferred-percent trust rules, plus the
 * collector's probe sequencing (monthly probe only when needed) and the
 * 401→refresh→retry contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GrokTokenConfig, SubscriptionAccountEntry } from '@omnicross/contracts/account-tokens-types';
import { AccountAllowanceStore } from '@omnicross/core/pipeline/AccountAllowanceStore';

import { GrokAllowanceCollector, parseGrokBillingPayloads } from '../GrokAllowanceCollector';

const NOW = Date.parse('2026-09-06T00:00:00.000Z');

// `parseWeeklyConfig`'s rollover rule compares the period end against the REAL
// wall clock (`Date.now()`), so the fixture periods (ending 2026-09-08) would
// silently flip semantics once the actual date passed them. Pin the clock to
// NOW for deterministic parsing tests.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

function creditsPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    config: {
      currentPeriod: { start: '2026-09-01T00:00:00Z', end: '2026-09-08T00:00:00Z', type: 'WEEKLY' },
      creditUsagePercent: 42.5,
      ...overrides,
    },
  };
}

function monthlyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    config: {
      billingPeriodStart: '2026-09-01T00:00:00Z',
      billingPeriodEnd: '2026-10-01T00:00:00Z',
      monthlyLimit: { val: 500 },
      used: { val: 100 },
      ...overrides,
    },
  };
}

describe('parseGrokBillingPayloads', () => {
  it('maps the weekly credits shape to a seven-day window', () => {
    const windows = parseGrokBillingPayloads(creditsPayload(), null, NOW)!;
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      id: 'seven-day',
      usedPercent: 42.5,
      resetsAt: '2026-09-08T00:00:00.000Z',
      state: 'fresh',
    });
  });

  it('rejects non-weekly period types and inverted ranges', () => {
    expect(parseGrokBillingPayloads(creditsPayload({
      currentPeriod: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z', type: 'MONTHLY' },
    }), null, NOW)).toBeNull();
    expect(parseGrokBillingPayloads(creditsPayload({
      currentPeriod: { start: '2026-09-08T00:00:00Z', end: '2026-09-01T00:00:00Z', type: 'WEEKLY' },
    }), null, NOW)).toBeNull();
  });

  it('maps the unified monthly shape to a thirty-day window', () => {
    const windows = parseGrokBillingPayloads(null, monthlyPayload(), NOW)!;
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ id: 'thirty-day', usedPercent: 20, windowMinutes: 43_200 });
  });

  it('keeps an explicit weekly percentage on a unified account, drops an inferred one', () => {
    // Explicit percent + unified flag: keep BOTH windows (live responses
    // sometimes carry both shapes; the monthly probe confirms the quota).
    const both = parseGrokBillingPayloads(
      creditsPayload({ isUnifiedBillingUser: true }),
      monthlyPayload(),
      NOW,
    )!;
    expect(both.map((w) => w.id)).toEqual(['seven-day', 'thirty-day']);

    // Inferred (absent) percent + unified: the monthly window wins alone — an
    // inferred 0% weekly on a unified account is a lie.
    const inferred = parseGrokBillingPayloads(
      creditsPayload({ creditUsagePercent: undefined, isUnifiedBillingUser: true }),
      monthlyPayload(),
      NOW,
    )!;
    expect(inferred.map((w) => w.id)).toEqual(['thirty-day']);

    // Inferred + unified + a monthly config that positively confirms NO
    // monthly quota (limit 0): the weekly cycle stands.
    const weeklyStands = parseGrokBillingPayloads(
      creditsPayload({ creditUsagePercent: undefined, isUnifiedBillingUser: true }),
      monthlyPayload({ monthlyLimit: { val: 0 }, used: { val: 0 } }),
      NOW,
    )!;
    expect(weeklyStands.map((w) => w.id)).toEqual(['seven-day']);

    // Inferred + unified + a FAILED monthly probe: unusable → retain last-good.
    expect(parseGrokBillingPayloads(
      creditsPayload({ creditUsagePercent: undefined, isUnifiedBillingUser: true }),
      null,
      NOW,
    )).toBeNull();
  });

  it('appends the on-demand cap as a third window when present', () => {
    const windows = parseGrokBillingPayloads(
      creditsPayload({ onDemandCap: { val: 200 }, onDemandUsed: { val: 50 } }),
      null,
      NOW,
    )!;
    expect(windows.map((w) => w.id)).toEqual(['seven-day', 'on-demand']);
    expect(windows[1]).toMatchObject({ usedPercent: 25 });
  });
});

function grokAccount(overrides: Partial<GrokTokenConfig> = {}): SubscriptionAccountEntry<GrokTokenConfig> {
  return {
    id: 'acct-1',
    tokens: { authMethod: 'oauth', status: 'authorized', ...overrides },
  };
}

describe('GrokAllowanceCollector', () => {
  function build(responses: Response[]) {
    const fetchImpl = vi.fn(async (url: string) => {
      const next = responses.shift();
      if (!next) throw new Error('no more canned responses');
      return next;
    });
    const refreshAccountToken = vi.fn(async () => true);
    const getAccessTokenForAccount = vi.fn(async () => 'at-1');
    const store = new AccountAllowanceStore();
    const collector = new GrokAllowanceCollector(
      { getAccessTokenForAccount, refreshAccountToken },
      store,
      fetchImpl as unknown as never,
      () => NOW,
    );
    return { collector, fetchImpl, refreshAccountToken, store };
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('serves the weekly window and only probes monthly when weekly is unusable/unified', async () => {
    // Usable weekly + NOT unified → exactly ONE probe (credits URL only).
    const { collector, fetchImpl } = build([json(creditsPayload())]);
    const snapshot = await collector.collect(grokAccount(), { force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('format=credits');
    expect(snapshot.windows[0]).toMatchObject({ id: 'seven-day', usedPercent: 42.5 });
    // The product-gate header rides on every billing request.
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-XAI-Token-Auth']).toBe('xai-grok-cli');
  });

  it('probes monthly for a unified account and reports the monthly window', async () => {
    const { collector, fetchImpl } = build([
      json(creditsPayload({ creditUsagePercent: undefined, isUnifiedBillingUser: true })),
      json(monthlyPayload()),
    ]);
    const snapshot = await collector.collect(grokAccount(), { force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).not.toContain('format=credits');
    expect(snapshot.windows.map((w) => w.id)).toEqual(['thirty-day']);
  });

  it('refreshes once on a billing 401 and retries the probe', async () => {
    const { collector, fetchImpl, refreshAccountToken } = build([
      json({ error: 'unauthorized' }, 401),
      json(creditsPayload()),
    ]);
    const snapshot = await collector.collect(grokAccount(), { force: true });
    expect(refreshAccountToken).toHaveBeenCalledWith('grok', 'acct-1');
    expect(snapshot.windows[0]).toMatchObject({ id: 'seven-day', usedPercent: 42.5 });
  });

  it('degrades to a failure snapshot (retaining last-good) when both probes fail', async () => {
    const { collector } = build([json({ oops: true }, 500), json({ oops: true }, 500)]);
    const snapshot = await collector.collect(grokAccount(), { force: true });
    expect(snapshot.lastErrorCode).toBe('grok_usage_invalid_response');
    expect(snapshot.windows.every((w) => w.state === 'unavailable' || w.state === 'stale')).toBe(true);
  });
});
