import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetSharedAccountAllowanceStoreForTests,
  AccountAllowanceStore,
  getSharedAccountAllowanceStore,
  parseClaudeAllowanceHeaders,
  parseCodexAllowanceHeaders,
} from '../AccountAllowanceStore';
import { __resetUpstreamProxyForTests, fetchUpstream } from '../upstreamFetch';

describe('Codex allowance parsing and storage', () => {
  it('normalizes both windows and the over-secondary value without retaining raw headers', () => {
    const store = new AccountAllowanceStore(() => Date.parse('2026-08-03T00:00:00.000Z'));
    const snapshot = store.recordCodexHeaders('account-a', new Headers({
      'x-codex-primary-used-percent': '42.5',
      'x-codex-primary-reset-after-seconds': '120',
      'x-codex-primary-window-minutes': '300',
      'x-codex-secondary-used-percent': '12',
      'x-codex-secondary-reset-after-seconds': '600',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-primary-over-secondary-limit-percent': '7.25',
      authorization: 'Bearer must-not-survive',
    }));

    expect(snapshot).toMatchObject({
      providerId: 'codex',
      accountId: 'account-a',
      source: 'response-headers',
      primaryOverSecondaryLimitPercent: 7.25,
      windows: [
        {
          id: 'primary',
          usedPercent: 42.5,
          windowMinutes: 300,
          resetsAt: '2026-08-03T00:02:00.000Z',
          state: 'fresh',
        },
        {
          id: 'secondary',
          usedPercent: 12,
          windowMinutes: 10080,
          resetsAt: '2026-08-03T00:10:00.000Z',
          state: 'fresh',
        },
      ],
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('must-not-survive');
    expect(serialized).not.toContain('x-codex-');
  });

  it('treats absent or invalid headers as no observation', () => {
    expect(parseCodexAllowanceHeaders(new Headers())).toBeNull();
    expect(parseCodexAllowanceHeaders({
      'x-codex-primary-used-percent': 'not-a-number',
      'x-codex-secondary-window-minutes': '-1',
    })).toBeNull();
  });

  it('ignores out-of-range percentages without discarding the previous snapshot', () => {
    const store = new AccountAllowanceStore(() => 1_000_000);
    store.recordCodexHeaders('account-a', {
      'x-codex-primary-used-percent': '42',
      'x-codex-secondary-used-percent': '24',
    });

    const preserved = store.recordCodexHeaders('account-a', {
      'x-codex-primary-used-percent': '101',
      'x-codex-secondary-used-percent': '-1',
      'x-codex-primary-over-secondary-limit-percent': '999',
    });
    expect(preserved?.windows.map((window) => window.usedPercent)).toEqual([42, 24]);
    expect(preserved?.primaryOverSecondaryLimitPercent).toBeUndefined();
  });

  it('does not clear an old snapshot on missing headers and preserves omitted windows on partial updates', () => {
    let now = 1_000_000;
    const store = new AccountAllowanceStore(() => now, 1_000);
    store.recordCodexHeaders('account-a', {
      'x-codex-primary-used-percent': '10',
      'x-codex-secondary-used-percent': '20',
      'x-codex-secondary-window-minutes': '10080',
    });

    now += 100;
    const unchanged = store.recordCodexHeaders('account-a', { 'content-type': 'application/json' });
    expect(unchanged?.windows.map((window) => window.usedPercent)).toEqual([10, 20]);

    now += 100;
    const partial = store.recordCodexHeaders('account-a', {
      'x-codex-primary-used-percent': '11',
    });
    expect(partial?.windows).toMatchObject([
      { id: 'primary', usedPercent: 11, state: 'fresh' },
      { id: 'secondary', usedPercent: 20, windowMinutes: 10080, state: 'stale' },
    ]);

    now += 1_001;
    expect(store.get('codex', 'account-a')?.windows[0]?.state).toBe('stale');
  });

  it('prefers the absolute reset-at stamp over the relative reset-after projection', () => {
    const store = new AccountAllowanceStore(() => Date.parse('2026-08-03T00:00:00.000Z'));
    const snapshot = store.recordCodexHeaders('account-a', {
      'x-codex-primary-used-percent': '42',
      // The two disagree; the absolute stamp wins (no observation-clock skew).
      'x-codex-primary-reset-at': '1785991200', // 2026-08-06T04:40:00Z
      'x-codex-primary-reset-after-seconds': '120',
      'x-codex-primary-window-minutes': '300',
    });
    expect(snapshot?.windows[0]?.resetsAt).toBe('2026-08-06T04:40:00.000Z');
  });

  it('still works with only the relative reset-after header', () => {
    const store = new AccountAllowanceStore(() => Date.parse('2026-08-03T00:00:00.000Z'));
    const snapshot = store.recordCodexHeaders('account-a', {
      'x-codex-primary-used-percent': '42',
      'x-codex-primary-reset-after-seconds': '120',
    });
    expect(snapshot?.windows[0]?.resetsAt).toBe('2026-08-03T00:02:00.000Z');
  });
});

describe('Claude unified rate-limit header capture', () => {
  it('parses the 0-1 utilization fractions and epoch-second resets', () => {
    expect(parseClaudeAllowanceHeaders(new Headers())).toBeNull();
    const observation = parseClaudeAllowanceHeaders(new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.41',
      'anthropic-ratelimit-unified-5h-reset': '1800',
      'anthropic-ratelimit-unified-7d-utilization': '0.22',
      'anthropic-ratelimit-unified-7d-reset': '500000',
      'anthropic-ratelimit-unified-7d_oi-utilization': '0.77',
      'anthropic-ratelimit-unified-7d_oi-reset': '500000',
    }));
    expect(observation).toMatchObject({
      fiveHour: { usedPercent: 41, resetAtMs: 1_800_000 },
      sevenDay: { usedPercent: 22, resetAtMs: 500_000_000 },
      scopedSevenDay: { usedPercent: 77 },
    });
  });

  it('merges live headers into an existing oauth snapshot without losing scoped windows', () => {
    let now = Date.parse('2026-08-03T00:00:00.000Z');
    const store = new AccountAllowanceStore(() => now);
    // Seed an oauth-usage snapshot with a scoped weekly row.
    store.set({
      providerId: 'claude',
      accountId: 'claude-a',
      source: 'oauth-usage-api',
      observedAt: new Date(now).toISOString(),
      windows: [
        { id: 'five-hour', label: '5 hours', scope: 'all', usedPercent: 10, state: 'fresh' },
        { id: 'seven-day', label: '7 days', scope: 'all', usedPercent: 20, state: 'fresh' },
        { id: 'seven-day-sonnet', label: '7 days · Sonnet', scope: 'model-family', modelFamily: 'sonnet', usedPercent: 30, state: 'fresh' },
      ],
    });

    now += 60_000;
    const merged = store.recordClaudeHeaders('claude-a', new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.55',
      'anthropic-ratelimit-unified-5h-reset': '1800',
    }), now);

    expect(merged?.source).toBe('oauth-usage-api');
    expect(merged?.windows).toMatchObject([
      { id: 'five-hour', usedPercent: 55, state: 'fresh' },
      { id: 'seven-day', usedPercent: 20, state: 'stale' },
      // The unified 7d_oi slot renders as the Fable scoped row...
      { id: 'seven-day-fable', usedPercent: null, state: 'unavailable' },
      // ...and the scoped row the usage API reported survives the merge.
      { id: 'seven-day-sonnet', usedPercent: 30, modelFamily: 'sonnet' },
    ]);
  });

  it('creates a response-headers snapshot when none exists and stays a no-op without headers', () => {
    const store = new AccountAllowanceStore(() => Date.parse('2026-08-03T00:00:00.000Z'));
    const noop = store.recordClaudeHeaders('claude-a', { 'content-type': 'application/json' });
    expect(noop).toBeNull();

    const snapshot = store.recordClaudeHeaders('claude-a', new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.9',
    }));
    expect(snapshot).toMatchObject({
      providerId: 'claude',
      source: 'response-headers',
      windows: [
        { id: 'five-hour', usedPercent: 90, state: 'fresh' },
        { id: 'seven-day', usedPercent: null, state: 'unavailable' },
        { id: 'seven-day-fable', usedPercent: null, state: 'unavailable' },
      ],
    });
  });
});

describe('fetchUpstream Codex allowance attribution', () => {
  beforeEach(() => {
    __resetUpstreamProxyForTests();
    __resetSharedAccountAllowanceStoreForTests();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', {
      headers: { 'x-codex-primary-used-percent': '33' },
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetUpstreamProxyForTests();
    __resetSharedAccountAllowanceStoreForTests();
  });

  it('writes only to the explicit account selected in the egress context', async () => {
    await fetchUpstream('https://chatgpt.com/backend-api/codex/responses', {}, {
      providerId: 'codex',
      accountId: 'actually-selected',
    });

    expect(getSharedAccountAllowanceStore().get('codex', 'actually-selected'))
      .toMatchObject({ accountId: 'actually-selected' });
    expect(getSharedAccountAllowanceStore().get('codex', 'active-but-not-selected')).toBeNull();
  });

  it('does not capture when accountId is absent', async () => {
    await fetchUpstream('https://chatgpt.com/backend-api/codex/responses', {}, {
      providerId: 'codex',
    });
    expect(getSharedAccountAllowanceStore().list()).toEqual([]);
  });
});
