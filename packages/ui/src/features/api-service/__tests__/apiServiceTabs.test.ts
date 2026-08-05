import { describe, expect, it } from 'vitest';

import {
  API_SERVICE_SECTION_TAB,
  API_SERVICE_TABS,
  normalizeApiServiceTab,
  sectionsForApiServiceTab,
} from '../apiServiceTabModel';

describe('API service information architecture', () => {
  it('keeps the four gateway tasks in a stable request-path order', () => {
    expect(API_SERVICE_TABS.map((tab) => tab.id)).toEqual([
      'overview',
      'access',
      'activity',
      'settings',
    ]);
  });

  it('maps every capability section to exactly one existing tab', () => {
    const tabIds = new Set(API_SERVICE_TABS.map((tab) => tab.id));
    expect(Object.values(API_SERVICE_SECTION_TAB).every((tab) => tabIds.has(tab))).toBe(true);

    const mappedSections = API_SERVICE_TABS.flatMap((tab) => sectionsForApiServiceTab(tab.id));
    expect(new Set(mappedSections).size).toBe(Object.keys(API_SERVICE_SECTION_TAB).length);
  });

  it('keeps overview concise and places legacy routing in Settings', () => {
    expect(sectionsForApiServiceTab('overview')).toEqual([
      'serverStatus',
      'serviceControls',
      'queueStatus',
      'bindingCoverage',
    ]);
    expect(sectionsForApiServiceTab('access')).toEqual(['accessKeys', 'vouchers']);
    expect(sectionsForApiServiceTab('activity')).toEqual(['liveTrafficQueue', 'recentErrors']);
    expect(sectionsForApiServiceTab('settings')).toEqual(['endpointRouting']);
    expect(API_SERVICE_SECTION_TAB).not.toHaveProperty('networkBinding');
    expect(API_SERVICE_SECTION_TAB).not.toHaveProperty('requestQueue');
    expect(API_SERVICE_SECTION_TAB).not.toHaveProperty('upstreamProxy');
  });

  it('normalizes old in-memory callers while hashes redirect at the route boundary', () => {
    expect(normalizeApiServiceTab('status')).toBe('overview');
    expect(normalizeApiServiceTab('endpoints')).toBe('settings');
    expect(normalizeApiServiceTab('access-keys')).toBe('access');
    expect(normalizeApiServiceTab('live-traffic')).toBe('activity');
  });
});
