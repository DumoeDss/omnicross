import { describe, expect, it } from 'vitest';

import { normalizeSettingsTab, SETTINGS_TABS } from '../settingsTabModel';

describe('settings information architecture', () => {
  it('gives each low-frequency operational policy one Settings home plus pricing', () => {
    expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual([
      'general', 'network', 'security', 'data', 'notifications', 'advanced', 'billing', 'pricing',
    ]);
  });

  it('normalizes consolidated legacy tabs for direct in-memory navigation', () => {
    expect(normalizeSettingsTab('scheduling')).toBe('advanced');
    expect(normalizeSettingsTab('audit')).toBe('data');
    expect(normalizeSettingsTab('privacy')).toBe('security');
  });
});
