import type { PageId } from '../../shared/state/hashRoute';

export interface NavItemDef { id: PageId; icon: 'overview' | 'gateway' | 'usage' | 'upstreams' | 'integrations' | 'settings'; labelKey: string }
export interface NavGroupDef { id: 'run' | 'configure' | 'system'; items: NavItemDef[] }

export const NAV_GROUPS: NavGroupDef[] = [
  {
    id: 'run',
    items: [
      { id: 'overview', icon: 'overview', labelKey: 'nav.overview' },
      { id: 'api-service', icon: 'gateway', labelKey: 'nav.gateway' },
      { id: 'usage-stats', icon: 'usage', labelKey: 'nav.dashboard' },
    ],
  },
  {
    id: 'configure',
    items: [
      { id: 'upstreams', icon: 'upstreams', labelKey: 'nav.upstreams' },
      { id: 'integrations', icon: 'integrations', labelKey: 'nav.integrations' },
    ],
  },
  { id: 'system', items: [{ id: 'settings', icon: 'settings', labelKey: 'nav.settings' }] },
];

/** The four high-frequency destinations that stay visible in the mobile bar. */
export const MOBILE_PRIMARY_IDS: readonly PageId[] = [
  'overview',
  'api-service',
  'upstreams',
  'usage-stats',
];

export const MOBILE_MORE_LABEL_KEY = 'nav.more';
