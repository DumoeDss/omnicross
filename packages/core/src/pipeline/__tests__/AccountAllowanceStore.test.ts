import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetSharedAccountAllowanceStoreForTests,
  AccountAllowanceStore,
  getSharedAccountAllowanceStore,
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
