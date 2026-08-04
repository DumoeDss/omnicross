export const SETTINGS_TABS = [
  { id: 'general', labelKey: 'settings.tabs.general' },
  { id: 'network', labelKey: 'settings.tabs.network' },
  { id: 'security', labelKey: 'settings.tabs.security' },
  { id: 'data', labelKey: 'settings.tabs.data' },
  { id: 'notifications', labelKey: 'settings.tabs.notifications' },
  { id: 'advanced', labelKey: 'settings.tabs.advanced' },
  { id: 'billing', labelKey: 'settings.tabs.billing' },
  { id: 'pricing', labelKey: 'settings.tabs.pricing' },
] as const;

export type SettingsCanonicalTabId = (typeof SETTINGS_TABS)[number]['id'];

/** IDs kept in the type surface for callers from the pre-P4 navigation model. */
export type SettingsLegacyTabId = 'scheduling' | 'audit' | 'privacy';
export type SettingsTabId = SettingsCanonicalTabId | SettingsLegacyTabId;

export function normalizeSettingsTab(tab: SettingsTabId | undefined): SettingsCanonicalTabId {
  switch (tab) {
    case 'scheduling': return 'advanced';
    case 'audit': return 'data';
    case 'privacy': return 'security';
    default:
      return tab === 'general' || tab === 'network' || tab === 'security' || tab === 'data' ||
        tab === 'notifications' || tab === 'advanced' || tab === 'billing' || tab === 'pricing'
        ? tab
        : 'general';
  }
}
