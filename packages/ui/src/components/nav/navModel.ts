import type { PageId } from '../../shared/state/hashRoute';

export type NavIcon =
  | 'overview'
  | 'gateway'
  | 'access-keys'
  | 'route-activity'
  | 'usage'
  | 'upstreams'
  | 'integrations'
  | 'search'
  | 'settings';

export interface NavItemDef {
  /** Unique key for React lists and the mobile-primary selection. */
  key: string;
  page: PageId;
  icon: NavIcon;
  labelKey: string;
  /** Optional tab for pages that carry one (currently api-service). */
  tab?: string;
}

export interface NavGroupDef { id: 'run' | 'configure' | 'system'; items: NavItemDef[] }

export const NAV_GROUPS: NavGroupDef[] = [
  {
    id: 'run',
    items: [
      { key: 'overview', page: 'overview', icon: 'overview', labelKey: 'nav.overview' },
      { key: 'usage-stats', page: 'usage-stats', icon: 'usage', labelKey: 'nav.dashboard' },
      { key: 'gateway', page: 'api-service', icon: 'gateway', labelKey: 'nav.gateway', tab: 'overview' },
      { key: 'route-activity', page: 'route-activity', icon: 'route-activity', labelKey: 'nav.routeActivity' },
    ],
  },
  {
    id: 'configure',
    items: [
      // search-settings-tab D1: the search runtime is a first-class capability
      // with its own configuration surface — a true sibling of the gateway
      // entry, first in the configure group.
      { key: 'search', page: 'search', icon: 'search', labelKey: 'nav.search' },
      { key: 'upstreams', page: 'upstreams', icon: 'upstreams', labelKey: 'nav.upstreams' },
      { key: 'access-keys', page: 'api-service', icon: 'access-keys', labelKey: 'nav.accessKeys', tab: 'access' },
      { key: 'integrations', page: 'integrations', icon: 'integrations', labelKey: 'nav.integrations' },
    ],
  },
  { id: 'system', items: [{ key: 'settings', page: 'settings', icon: 'settings', labelKey: 'nav.settings' }] },
];

/** The high-frequency destinations that stay visible in the mobile bar (by key). */
export const MOBILE_PRIMARY_KEYS: readonly string[] = [
  'overview',
  'gateway',
  'upstreams',
  'usage-stats',
];

export const MOBILE_MORE_LABEL_KEY = 'nav.more';
