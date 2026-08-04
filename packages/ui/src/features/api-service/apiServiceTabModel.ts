export const API_SERVICE_TABS = [
  { id: 'status', labelKey: 'apiService.tabs.status' },
  { id: 'routes', labelKey: 'apiService.tabs.routes' },
  { id: 'access-keys', labelKey: 'apiService.tabs.accessKeys' },
  { id: 'live-traffic', labelKey: 'apiService.tabs.liveTraffic' },
] as const;

export type ApiServiceCanonicalTabId = (typeof API_SERVICE_TABS)[number]['id'];

/** IDs kept in the type surface for callers from the pre-P4 navigation model. */
export type ApiServiceLegacyTabId = 'overview' | 'endpoints' | 'access' | 'network' | 'advanced';
export type ApiServiceTabId = ApiServiceCanonicalTabId | ApiServiceLegacyTabId;

export function normalizeApiServiceTab(tab: ApiServiceTabId | undefined): ApiServiceCanonicalTabId {
  switch (tab) {
    case 'overview': return 'status';
    case 'endpoints': return 'routes';
    case 'access': return 'access-keys';
    default: return tab === 'status' || tab === 'routes' || tab === 'access-keys' || tab === 'live-traffic' ? tab : 'status';
  }
}

/**
 * Inventory of the page's existing capability sections after the information-
 * architecture split. Keeping this explicit makes it difficult to lose a
 * section when the page is reorganised again.
 */
export const API_SERVICE_SECTION_TAB = {
  serverStatus: 'status',
  serviceControls: 'status',
  queueStatus: 'status',
  endpointRouting: 'routes',
  accessKeys: 'access-keys',
  vouchers: 'access-keys',
  liveTrafficQueue: 'live-traffic',
  recentErrors: 'live-traffic',
} as const satisfies Record<string, ApiServiceTabId>;

export type ApiServiceSectionId = keyof typeof API_SERVICE_SECTION_TAB;

export function sectionsForApiServiceTab(tab: ApiServiceTabId): ApiServiceSectionId[] {
  return (Object.keys(API_SERVICE_SECTION_TAB) as ApiServiceSectionId[]).filter(
    (section) => API_SERVICE_SECTION_TAB[section] === tab,
  );
}
