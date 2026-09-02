export const API_SERVICE_TABS = [
  { id: 'overview', labelKey: 'apiService.tabs.overview' },
  { id: 'access', labelKey: 'apiService.tabs.access' },
] as const;

export type ApiServiceCanonicalTabId = (typeof API_SERVICE_TABS)[number]['id'];

/**
 * IDs kept in the type surface for callers from the pre-P4 navigation model.
 * `settings`/`routes`/`endpoints` addressed the removed global endpoint
 * fallback; model routing now lives on the Upstreams page. The live-traffic /
 * activity tab graduated to the standalone Route Activity page.
 */
export type ApiServiceLegacyTabId = 'status' | 'routes' | 'access-keys' | 'endpoints' | 'settings' | 'network' | 'advanced';
export type ApiServiceTabId = ApiServiceCanonicalTabId | ApiServiceLegacyTabId;

export function normalizeApiServiceTab(tab: ApiServiceTabId | undefined): ApiServiceCanonicalTabId {
  switch (tab) {
    case 'access-keys': return 'access';
    default: return tab === 'overview' || tab === 'access' ? tab : 'overview';
  }
}

/**
 * Inventory of the page's existing capability sections after the information-
 * architecture split. Keeping this explicit makes it difficult to lose a
 * section when the page is reorganised again.
 */
export const API_SERVICE_SECTION_TAB = {
  serverStatus: 'overview',
  serviceControls: 'overview',
  queueStatus: 'overview',
  bindingCoverage: 'overview',
  searchSettings: 'overview',
  accessKeys: 'access',
  vouchers: 'access',
} as const satisfies Record<string, ApiServiceTabId>;

export type ApiServiceSectionId = keyof typeof API_SERVICE_SECTION_TAB;

export function sectionsForApiServiceTab(tab: ApiServiceTabId): ApiServiceSectionId[] {
  return (Object.keys(API_SERVICE_SECTION_TAB) as ApiServiceSectionId[]).filter(
    (section) => API_SERVICE_SECTION_TAB[section] === tab,
  );
}
