import { describe, expect, it } from 'vitest';

import {
  LEGACY_API_TAB_REDIRECTS,
  LEGACY_SETTINGS_TAB_REDIRECTS,
  parseHashRoute,
  routeToHash,
  selectedAccountFromRoute,
  withoutSelectedAccount,
} from '../hashRoute';

describe('hashRoute', () => {
  it('restores pages and supported nested tabs', () => {
    expect(parseHashRoute('#/api-service/activity')).toEqual({ page: 'api-service', tab: 'activity' });
    expect(parseHashRoute('#/settings/pricing')).toEqual({ page: 'settings', tab: 'pricing' });
    expect(parseHashRoute('#/settings/advanced')).toEqual({ page: 'settings', tab: 'advanced' });
    expect(routeToHash({ page: 'api-service', tab: 'status' })).toBe('#/api-service');
    expect(routeToHash({ page: 'api-service', tab: 'live-traffic' })).toBe('#/api-service/activity');
    expect(routeToHash({ page: 'settings', tab: 'pricing' })).toBe('#/settings/pricing');
  });

  it('falls back safely for unknown pages and tabs', () => {
    expect(parseHashRoute('#/unknown/nope')).toEqual({ page: 'overview' });
    expect(parseHashRoute('#/api-service/nope')).toEqual({ page: 'api-service' });
  });

  it('redirects every legacy Gateway and Settings tab explicitly', () => {
    expect(parseHashRoute('#/api-service/status')).toEqual({ page: 'api-service', tab: 'overview' });
    // Endpoint routing moved to the Upstreams page with the global fallback removed.
    expect(parseHashRoute('#/api-service/routes')).toEqual({ page: 'upstreams' });
    expect(parseHashRoute('#/api-service/endpoints')).toEqual({ page: 'upstreams' });
    expect(parseHashRoute('#/api-service/settings')).toEqual({ page: 'upstreams' });
    expect(parseHashRoute('#/api-service/access-keys')).toEqual({ page: 'api-service', tab: 'access' });
    expect(parseHashRoute('#/api-service/live-traffic')).toEqual({ page: 'api-service', tab: 'activity' });
    expect(parseHashRoute('#/api-service/access')).toEqual({ page: 'api-service', tab: 'access' });
    expect(parseHashRoute('#/api-service/network')).toEqual({ page: 'settings', tab: 'network' });
    expect(parseHashRoute('#/api-service/advanced')).toEqual({ page: 'settings', tab: 'advanced' });
    expect(parseHashRoute('#/settings/scheduling')).toEqual({ page: 'settings', tab: 'advanced' });
    expect(parseHashRoute('#/settings/audit')).toEqual({ page: 'settings', tab: 'data' });
    expect(parseHashRoute('#/settings/privacy')).toEqual({ page: 'settings', tab: 'security' });
    expect(Object.keys(LEGACY_API_TAB_REDIRECTS)).toEqual([
      'status',
      'access-keys',
      'live-traffic',
      'routes',
      'endpoints',
      'settings',
      'network',
      'advanced',
    ]);
    expect(Object.keys(LEGACY_SETTINGS_TAB_REDIRECTS)).toEqual(['scheduling', 'audit', 'privacy']);
  });

  it('keeps legacy pricing and code-cli bookmarks useful', () => {
    expect(parseHashRoute('#/pricing')).toEqual({ page: 'settings', tab: 'pricing' });
    expect(parseHashRoute('#/code-cli')).toEqual({ page: 'integrations' });
  });

  it('round-trips the downstream route workspace selection', () => {
    const route = { page: 'upstreams' as const, upstreamTab: 'routes' as const, downstreamId: 'route/one' };
    expect(routeToHash(route)).toBe('#/upstreams?view=routes&downstreamId=route%2Fone');
    expect(parseHashRoute(routeToHash(route))).toEqual(route);
    expect(parseHashRoute('#/upstreams?view=unknown&downstreamId=route')).toEqual({
      page: 'upstreams',
      downstreamId: 'route',
    });
  });

  it('round-trips account selection, meaningful filters, and unsafe text safely', () => {
    const route = {
      page: 'upstreams' as const,
      upstreamKind: 'account' as const,
      upstreamFilter: 'account' as const,
      upstreamQuery: 'email + label',
      accountProvider: 'claude' as const,
      accountId: 'account/one?region=cn&中文',
      accountFilters: {
        query: 'email + label',
        provider: 'codex' as const,
        group: 'pool/one',
        health: 'rate_limited' as const,
        credential: 'authorized' as const,
        scheduling: 'schedulable' as const,
        sort: 'last-used' as const,
        direction: 'desc' as const,
      },
    };

    const hash = routeToHash(route);
    expect(hash).toContain('accountId=account%2Fone%3Fregion%3Dcn%26%E4%B8%AD%E6%96%87');
    expect(hash).toContain('accountHealth=rate_limited');
    expect(parseHashRoute(hash)).toEqual(route);
  });

  it('redirects legacy account/provider bookmarks and rejects invalid selections', () => {
    expect(routeToHash({
      page: 'upstreams',
      upstreamKind: 'account',
      upstreamFilter: 'account',
      accountProvider: 'codex',
      accountId: 'one',
      accountFilters: { query: '', provider: 'all', sort: 'priority', direction: 'asc' },
    })).toBe('#/upstreams?kind=account&filter=account&accountProvider=codex&accountId=one');

    expect(parseHashRoute('#/accounts?accountProvider=unknown&accountId=one&detail=wat&provider=unknown&health=wat&sort=wat')).toEqual({ page: 'upstreams', upstreamFilter: 'account' });
    expect(parseHashRoute('#/accounts?accountProvider=claude&detail=diagnostics&q=needle')).toEqual({
      page: 'upstreams',
      upstreamFilter: 'account',
      upstreamQuery: 'needle',
      accountFilters: { query: 'needle' },
    });
    expect(parseHashRoute('#/accounts?accountProvider=claude&accountId=one&accountId=two')).toEqual({ page: 'upstreams', upstreamFilter: 'account' });
    expect(parseHashRoute('#/accounts?q=%ZZ')).toEqual({ page: 'upstreams', upstreamFilter: 'account' });
    expect(parseHashRoute('#/providers?providerId=openrouter')).toEqual({
      page: 'upstreams',
      upstreamFilter: 'provider',
      upstreamProviderId: 'openrouter',
    });
    expect(routeToHash({ page: 'upstreams', upstreamKind: 'account', accountProvider: 'claude', accountId: 'bad\u0000id' })).toBe('#/upstreams?kind=account');
  });

  it('provides pure selection helpers for async reconciliation and closing', () => {
    const route = { page: 'upstreams' as const, upstreamKind: 'account' as const, accountProvider: 'gemini' as const, accountId: 'gone', accountFilters: { query: 'keep' } };
    expect(selectedAccountFromRoute(route)).toEqual({ providerId: 'gemini', accountId: 'gone' });
    expect(withoutSelectedAccount(route)).toEqual({ page: 'upstreams', upstreamKind: 'account', accountFilters: { query: 'keep' } });
    expect(selectedAccountFromRoute({ page: 'upstreams', accountProvider: 'gemini' })).toBeNull();
  });
});
