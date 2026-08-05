import { useCallback, useEffect, useState } from 'react';

import type { ApiServiceTabId } from '@/features/api-service/apiServiceTabModel';
import type { AccountFilters } from '@/features/accounts/accountManagementModel';
import type { SettingsTabId } from '@/features/settings/settingsTabModel';
import type { SubscriptionProviderId } from '@/daemon/types';

export type PageId =
  | 'overview'
  | 'api-service'
  | 'upstreams'
  | 'integrations'
  | 'usage-stats'
  | 'settings';

export type AccountDetailTabId =
  | 'overview'
  | 'routes'
  | 'allowance'
  | 'scheduling'
  | 'network'
  | 'diagnostics'
  | 'danger';

export type AccountRouteFilters = Partial<AccountFilters>;
export type UpstreamKind = 'account' | 'account-group' | 'provider';

export interface AppRoute {
  page: PageId;
  tab?: ApiServiceTabId | SettingsTabId;
  accountProvider?: SubscriptionProviderId;
  accountId?: string;
  accountTab?: AccountDetailTabId;
  accountFilters?: AccountRouteFilters;
  upstreamKind?: UpstreamKind;
  upstreamFilter?: UpstreamKind | 'all';
  upstreamProviderId?: string;
  upstreamGroup?: string;
  upstreamQuery?: string;
}

export interface AccountRouteSelection {
  providerId: SubscriptionProviderId;
  accountId: string;
}

export interface NavigateOptions {
  /** Replace transient state such as search/filter edits instead of pushing it. */
  replace?: boolean;
}

export type RouteNavigate = (route: AppRoute, options?: NavigateOptions) => void;

const PAGE_IDS = new Set<PageId>([
  'overview',
  'api-service',
  'upstreams',
  'integrations',
  'usage-stats',
  'settings',
]);
const API_TABS = new Set<ApiServiceTabId>(['overview', 'access', 'activity', 'settings']);
const SETTINGS_TABS = new Set<SettingsTabId>([
  'general',
  'network',
  'security',
  'data',
  'notifications',
  'advanced',
  'billing',
  'pricing',
]);
const ACCOUNT_PROVIDERS = new Set<SubscriptionProviderId>(['claude', 'codex', 'gemini', 'opencodego']);
const ACCOUNT_DETAIL_TABS = new Set<AccountDetailTabId>([
  'overview',
  'routes',
  'allowance',
  'scheduling',
  'network',
  'diagnostics',
  'danger',
]);
const ACCOUNT_HEALTH = new Set<NonNullable<AccountFilters['health']>>([
  'healthy',
  'rate_limited',
  'overloaded',
  'transient',
  'blocked',
]);
const ACCOUNT_CREDENTIALS = new Set<AccountFilters['credential']>([
  'all',
  'authorized',
  'configured',
  'expired',
  'error',
  'unconfigured',
]);
const ACCOUNT_SCHEDULING = new Set<AccountFilters['scheduling']>([
  'all',
  'enabled',
  'disabled',
  'schedulable',
  'excluded',
]);
const ACCOUNT_SORTS = new Set<AccountFilters['sort']>([
  'label',
  'priority',
  'last-used',
  'allowance',
  'reset-time',
]);

export const DEFAULT_ROUTE: AppRoute = { page: 'overview' };

/** Explicit redirects for hashes written by the pre-P4 Gateway tabs. */
export const LEGACY_API_TAB_REDIRECTS: Readonly<Record<string, AppRoute>> = {
  status: { page: 'api-service', tab: 'overview' },
  routes: { page: 'api-service', tab: 'settings' },
  'access-keys': { page: 'api-service', tab: 'access' },
  'live-traffic': { page: 'api-service', tab: 'activity' },
  endpoints: { page: 'api-service', tab: 'settings' },
  network: { page: 'settings', tab: 'network' },
  advanced: { page: 'settings', tab: 'advanced' },
};

/** Explicit redirects for the Settings tabs that were consolidated in P4. */
export const LEGACY_SETTINGS_TAB_REDIRECTS: Readonly<Record<string, AppRoute>> = {
  scheduling: { page: 'settings', tab: 'advanced' },
  audit: { page: 'settings', tab: 'data' },
  privacy: { page: 'settings', tab: 'security' },
};

/** Page-level bookmarks retained from the previous navigation model. */
export const LEGACY_PAGE_REDIRECTS: Readonly<Record<string, AppRoute>> = {
  pricing: { page: 'settings', tab: 'pricing' },
  'code-cli': { page: 'integrations' },
};

const UPSTREAM_KINDS = new Set<UpstreamKind>(['account', 'account-group', 'provider']);
const UPSTREAM_FILTERS = new Set<UpstreamKind | 'all'>(['all', ...UPSTREAM_KINDS]);

const MAX_ROUTE_TEXT_LENGTH = 512;

function isSafeRouteText(value: string | undefined, allowEmpty = false): value is string {
  return typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    value.length <= MAX_ROUTE_TEXT_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function enumValue<T extends string>(value: string | undefined, values: ReadonlySet<T>): T | undefined {
  return value !== undefined && values.has(value as T) ? value as T : undefined;
}

function parseQuery(rawQuery: string): URLSearchParams | null {
  // URLSearchParams is intentionally forgiving of malformed percent escapes.
  // Reject those escapes first so a broken bookmark cannot silently change the
  // meaning of an account id or filter value.
  if (/%(?![0-9a-f]{2})/iu.test(rawQuery)) return null;
  try {
    return new URLSearchParams(rawQuery);
  } catch {
    return null;
  }
}

function singleQueryValue(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key);
  if (values.length !== 1) return undefined;
  return isSafeRouteText(values[0], true) ? values[0] : undefined;
}

function accountFiltersFromQuery(params: URLSearchParams): AccountRouteFilters | undefined {
  const filters: AccountRouteFilters = {};
  const query = singleQueryValue(params, 'q');
  if (isSafeRouteText(query) && query.trim()) filters.query = query;

  const provider = enumValue(singleQueryValue(params, 'provider'), new Set(['all', ...ACCOUNT_PROVIDERS] as const));
  if (provider && provider !== 'all') filters.provider = provider;

  const group = singleQueryValue(params, 'group');
  if (isSafeRouteText(group) && group !== 'all') filters.group = group;

  const health = enumValue(singleQueryValue(params, 'health'), ACCOUNT_HEALTH);
  if (health) filters.health = health;

  const credential = enumValue(singleQueryValue(params, 'credential'), ACCOUNT_CREDENTIALS);
  if (credential && credential !== 'all') filters.credential = credential;

  const scheduling = enumValue(singleQueryValue(params, 'scheduling'), ACCOUNT_SCHEDULING);
  if (scheduling && scheduling !== 'all') filters.scheduling = scheduling;

  const sort = enumValue(singleQueryValue(params, 'sort'), ACCOUNT_SORTS);
  if (sort && sort !== 'priority') filters.sort = sort;

  const direction = enumValue(singleQueryValue(params, 'dir'), new Set(['asc', 'desc'] as const));
  if (direction && direction !== 'asc') filters.direction = direction;

  return Object.keys(filters).length ? filters : undefined;
}

function accountFiltersFromUpstreamsQuery(params: URLSearchParams): AccountRouteFilters | undefined {
  const accountParams = new URLSearchParams();
  const mappings = [
    ['accountQuery', 'q'],
    ['accountFilterProvider', 'provider'],
    ['accountGroup', 'group'],
    ['accountHealth', 'health'],
    ['accountCredential', 'credential'],
    ['accountScheduling', 'scheduling'],
    ['accountSort', 'sort'],
    ['accountDirection', 'dir'],
  ] as const;
  for (const [source, target] of mappings) {
    const value = singleQueryValue(params, source);
    if (value !== undefined) accountParams.set(target, value);
  }
  return accountFiltersFromQuery(accountParams);
}

function splitHash(hash: string): { path: string; query: string } {
  const withoutPrefix = hash.replace(/^#/, '').replace(/^\/?/, '');
  const queryIndex = withoutPrefix.indexOf('?');
  if (queryIndex < 0) return { path: withoutPrefix, query: '' };
  const path = withoutPrefix.slice(0, queryIndex);
  const rawQuery = withoutPrefix.slice(queryIndex + 1);
  // A literal second hash is not a valid query value. It is commonly produced
  // by an unescaped account id pasted into a bookmark, so ignore that suffix.
  return { path, query: rawQuery.split('#', 1)[0] ?? '' };
}

export function parseHashRoute(hash: string): AppRoute {
  const { path, query: rawQuery } = splitHash(hash);
  const [rawPage = '', rawTab] = path.split('/').filter(Boolean);

  if (rawPage === 'accounts') {
    const params = parseQuery(rawQuery);
    if (!params) return { page: 'upstreams', upstreamFilter: 'account' };
    const route = parseUpstreamsQuery(params, { page: 'upstreams', upstreamFilter: 'account' });
    delete route.upstreamProviderId;
    delete route.upstreamGroup;
    const legacyFilters = accountFiltersFromQuery(params);
    if (legacyFilters) route.accountFilters = legacyFilters;
    if (legacyFilters?.query && !route.upstreamQuery) route.upstreamQuery = legacyFilters.query;
    return route;
  }
  if (rawPage === 'providers') {
    const params = parseQuery(rawQuery);
    return params
      ? parseUpstreamsQuery(params, { page: 'upstreams', upstreamFilter: 'provider' })
      : { page: 'upstreams', upstreamFilter: 'provider' };
  }

  // Keep bookmarks from the previous navigation model useful.
  const legacyPage = LEGACY_PAGE_REDIRECTS[rawPage];
  if (legacyPage) return legacyPage;
  if (!PAGE_IDS.has(rawPage as PageId)) return DEFAULT_ROUTE;

  const page = rawPage as PageId;
  if (page === 'api-service' && rawTab) {
    const legacyTab = LEGACY_API_TAB_REDIRECTS[rawTab];
    if (legacyTab) return legacyTab;
  }
  if (page === 'api-service' && API_TABS.has(rawTab as ApiServiceTabId)) {
    return { page, tab: rawTab as ApiServiceTabId };
  }
  if (page === 'settings' && rawTab) {
    const legacyTab = LEGACY_SETTINGS_TAB_REDIRECTS[rawTab];
    if (legacyTab) return legacyTab;
  }
  if (page === 'settings' && SETTINGS_TABS.has(rawTab as SettingsTabId)) {
    return { page, tab: rawTab as SettingsTabId };
  }
  if (page !== 'upstreams') return { page };

  const params = parseQuery(rawQuery);
  if (!params) return { page };
  return parseUpstreamsQuery(params, { page });
}

function parseUpstreamsQuery(params: URLSearchParams, base: AppRoute): AppRoute {
  const route: AppRoute = { ...base };
  const kind = enumValue(singleQueryValue(params, 'kind'), UPSTREAM_KINDS);
  const filter = enumValue(singleQueryValue(params, 'filter'), UPSTREAM_FILTERS);
  const query = singleQueryValue(params, 'q');
  const upstreamProviderId = singleQueryValue(params, 'providerId');
  const upstreamGroup = singleQueryValue(params, 'group');
  if (kind) route.upstreamKind = kind;
  if (filter && filter !== 'all') route.upstreamFilter = filter;
  if (isSafeRouteText(query) && query.trim()) route.upstreamQuery = query;
  if (isSafeRouteText(upstreamProviderId)) route.upstreamProviderId = upstreamProviderId;
  if (isSafeRouteText(upstreamGroup)) route.upstreamGroup = upstreamGroup;

  const provider = enumValue(singleQueryValue(params, 'accountProvider'), ACCOUNT_PROVIDERS);
  const accountId = singleQueryValue(params, 'accountId');
  const accountTab = enumValue(singleQueryValue(params, 'detail'), ACCOUNT_DETAIL_TABS);
  if (provider && isSafeRouteText(accountId)) {
    route.accountProvider = provider;
    route.accountId = accountId;
    route.upstreamKind = 'account';
    if (accountTab) route.accountTab = accountTab;
  }
  const accountFilters = accountFiltersFromUpstreamsQuery(params);
  if (accountFilters) route.accountFilters = accountFilters;
  return route;
}

export function selectedAccountFromRoute(route: AppRoute): AccountRouteSelection | null {
  if (!route.accountProvider || !ACCOUNT_PROVIDERS.has(route.accountProvider) || !isSafeRouteText(route.accountId)) return null;
  return { providerId: route.accountProvider, accountId: route.accountId };
}

export function withoutSelectedAccount(route: AppRoute): AppRoute {
  const { accountProvider: _provider, accountId: _id, accountTab: _tab, ...rest } = route;
  return rest;
}

function appendAccountFiltersQuery(params: URLSearchParams, route: AppRoute): void {
  const filters = route.accountFilters;
  if (!filters) return;
  if (isSafeRouteText(filters.query) && filters.query.trim()) params.set('accountQuery', filters.query);
  const provider = enumValue(filters.provider, new Set(['all', ...ACCOUNT_PROVIDERS] as const));
  if (provider && provider !== 'all') params.set('accountFilterProvider', provider);
  if (isSafeRouteText(filters.group) && filters.group !== 'all') params.set('accountGroup', filters.group);
  const health = enumValue(filters.health, ACCOUNT_HEALTH);
  if (health && health !== 'all') params.set('accountHealth', health);
  const credential = enumValue(filters.credential, ACCOUNT_CREDENTIALS);
  if (credential && credential !== 'all') params.set('accountCredential', credential);
  const scheduling = enumValue(filters.scheduling, ACCOUNT_SCHEDULING);
  if (scheduling && scheduling !== 'all') params.set('accountScheduling', scheduling);
  const sort = enumValue(filters.sort, ACCOUNT_SORTS);
  if (sort && sort !== 'priority') params.set('accountSort', sort);
  const direction = enumValue(filters.direction, new Set(['asc', 'desc'] as const));
  if (direction && direction !== 'asc') params.set('accountDirection', direction);
}

function appendUpstreamsQuery(params: URLSearchParams, route: AppRoute): void {
  if (route.upstreamKind && UPSTREAM_KINDS.has(route.upstreamKind)) params.set('kind', route.upstreamKind);
  if (route.upstreamFilter && route.upstreamFilter !== 'all' && UPSTREAM_FILTERS.has(route.upstreamFilter)) {
    params.set('filter', route.upstreamFilter);
  }
  if (isSafeRouteText(route.upstreamQuery) && route.upstreamQuery.trim()) params.set('q', route.upstreamQuery);
  if (isSafeRouteText(route.upstreamProviderId)) params.set('providerId', route.upstreamProviderId);
  if (isSafeRouteText(route.upstreamGroup)) params.set('group', route.upstreamGroup);
  const selection = selectedAccountFromRoute(route);
  if (selection) {
    params.set('accountProvider', selection.providerId);
    params.set('accountId', selection.accountId);
    if (route.accountTab && ACCOUNT_DETAIL_TABS.has(route.accountTab) && route.accountTab !== 'overview') {
      params.set('detail', route.accountTab);
    }
  }
  appendAccountFiltersQuery(params, route);
}

export function routeToHash(route: AppRoute): string {
  const page = PAGE_IDS.has(route.page) ? route.page : DEFAULT_ROUTE.page;

  if (page === 'api-service') {
    const legacy = route.tab ? LEGACY_API_TAB_REDIRECTS[route.tab] : undefined;
    if (legacy && legacy.page !== 'api-service') return routeToHash(legacy);
    const tab = legacy?.tab ?? (API_TABS.has(route.tab as ApiServiceTabId) ? route.tab : undefined);
    return `#/api-service${tab && tab !== 'overview' ? `/${tab}` : ''}`;
  }
  if (page === 'settings') {
    const legacy = route.tab ? LEGACY_SETTINGS_TAB_REDIRECTS[route.tab] : undefined;
    const tab = legacy?.tab ?? (SETTINGS_TABS.has(route.tab as SettingsTabId) ? route.tab : undefined);
    return `#/settings${tab && tab !== 'general' ? `/${tab}` : ''}`;
  }
  if (page !== 'upstreams') return `#/${page}`;

  const params = new URLSearchParams();
  appendUpstreamsQuery(params, route);
  const query = params.toString();
  return `#/upstreams${query ? `?${query}` : ''}`;
}

function readRoute(): AppRoute {
  return typeof window === 'undefined' ? DEFAULT_ROUTE : parseHashRoute(window.location.hash);
}

export function useHashRoute(): [AppRoute, RouteNavigate] {
  const [route, setRoute] = useState<AppRoute>(readRoute);

  useEffect(() => {
    const sync = () => {
      const next = readRoute();
      setRoute(next);
      const canonical = routeToHash(next);
      if (window.location.hash !== canonical) {
        window.history.replaceState(null, '', canonical);
      }
    };

    window.addEventListener('hashchange', sync);
    sync();
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const navigate = useCallback<RouteNavigate>((next, options) => {
    if (typeof window === 'undefined') return;
    const hash = routeToHash(next);
    const parsed = parseHashRoute(hash);
    if (window.location.hash === hash) {
      setRoute(parsed);
      return;
    }
    if (options?.replace) {
      window.history.replaceState(null, '', hash);
      setRoute(parsed);
      return;
    }
    window.location.hash = hash;
    setRoute(parsed);
  }, []);

  return [route, navigate];
}
