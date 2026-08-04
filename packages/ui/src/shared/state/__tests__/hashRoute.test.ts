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
    expect(parseHashRoute('#/api-service/routes')).toEqual({ page: 'api-service', tab: 'routes' });
    expect(parseHashRoute('#/settings/pricing')).toEqual({ page: 'settings', tab: 'pricing' });
    expect(parseHashRoute('#/settings/advanced')).toEqual({ page: 'settings', tab: 'advanced' });
    expect(routeToHash({ page: 'api-service', tab: 'status' })).toBe('#/api-service');
    expect(routeToHash({ page: 'api-service', tab: 'live-traffic' })).toBe('#/api-service/live-traffic');
    expect(routeToHash({ page: 'settings', tab: 'pricing' })).toBe('#/settings/pricing');
  });

  it('falls back safely for unknown pages and tabs', () => {
    expect(parseHashRoute('#/unknown/nope')).toEqual({ page: 'overview' });
    expect(parseHashRoute('#/api-service/nope')).toEqual({ page: 'api-service' });
  });

  it('redirects every pre-P4 Gateway and Settings tab explicitly', () => {
    expect(parseHashRoute('#/api-service/overview')).toEqual({ page: 'api-service', tab: 'status' });
    expect(parseHashRoute('#/api-service/endpoints')).toEqual({ page: 'api-service', tab: 'routes' });
    expect(parseHashRoute('#/api-service/access')).toEqual({ page: 'api-service', tab: 'access-keys' });
    expect(parseHashRoute('#/api-service/network')).toEqual({ page: 'settings', tab: 'network' });
    expect(parseHashRoute('#/api-service/advanced')).toEqual({ page: 'settings', tab: 'advanced' });
    expect(parseHashRoute('#/settings/scheduling')).toEqual({ page: 'settings', tab: 'advanced' });
    expect(parseHashRoute('#/settings/audit')).toEqual({ page: 'settings', tab: 'data' });
    expect(parseHashRoute('#/settings/privacy')).toEqual({ page: 'settings', tab: 'security' });
    expect(Object.keys(LEGACY_API_TAB_REDIRECTS)).toEqual(['overview', 'endpoints', 'access', 'network', 'advanced']);
    expect(Object.keys(LEGACY_SETTINGS_TAB_REDIRECTS)).toEqual(['scheduling', 'audit', 'privacy']);
  });

  it('keeps legacy pricing and code-cli bookmarks useful', () => {
    expect(parseHashRoute('#/pricing')).toEqual({ page: 'settings', tab: 'pricing' });
    expect(parseHashRoute('#/code-cli')).toEqual({ page: 'integrations' });
  });

  it('round-trips account selection, detail tab, meaningful filters, and unsafe text safely', () => {
    const route = {
      page: 'accounts' as const,
      accountProvider: 'claude' as const,
      accountId: 'account/one?region=cn&中文',
      accountTab: 'diagnostics' as const,
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
    expect(parseHashRoute(hash)).toEqual(route);
  });

  it('omits defaults and rejects invalid or partial account route values', () => {
    expect(routeToHash({
      page: 'accounts',
      accountProvider: 'codex',
      accountId: 'one',
      accountTab: 'overview',
      accountFilters: { query: '', provider: 'all', sort: 'priority', direction: 'asc' },
    })).toBe('#/accounts?accountProvider=codex&accountId=one');

    expect(parseHashRoute('#/accounts?accountProvider=unknown&accountId=one&detail=wat&provider=unknown&health=wat&sort=wat')).toEqual({ page: 'accounts' });
    expect(parseHashRoute('#/accounts?accountProvider=claude&detail=diagnostics&q=needle')).toEqual({
      page: 'accounts',
      accountFilters: { query: 'needle' },
    });
    expect(parseHashRoute('#/accounts?accountProvider=claude&accountId=one&accountId=two')).toEqual({ page: 'accounts' });
    expect(parseHashRoute('#/accounts?q=%ZZ')).toEqual({ page: 'accounts' });
    expect(routeToHash({ page: 'accounts', accountProvider: 'claude', accountId: 'bad\u0000id' })).toBe('#/accounts');
  });

  it('provides pure selection helpers for async reconciliation and closing', () => {
    const route = { page: 'accounts' as const, accountProvider: 'gemini' as const, accountId: 'gone', accountTab: 'allowance' as const, accountFilters: { query: 'keep' } };
    expect(selectedAccountFromRoute(route)).toEqual({ providerId: 'gemini', accountId: 'gone' });
    expect(withoutSelectedAccount(route)).toEqual({ page: 'accounts', accountFilters: { query: 'keep' } });
    expect(selectedAccountFromRoute({ page: 'accounts', accountProvider: 'gemini' })).toBeNull();
  });
});
