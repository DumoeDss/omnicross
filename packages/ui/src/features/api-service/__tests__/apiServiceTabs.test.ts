import { describe, expect, it } from 'vitest';

import {
  API_SERVICE_SECTION_TAB,
  API_SERVICE_TABS,
  normalizeApiServiceTab,
  sectionsForApiServiceTab,
} from '../apiServiceTabModel';

describe('API service information architecture', () => {
  it('keeps the gateway tasks in a stable request-path order', () => {
    expect(API_SERVICE_TABS.map((tab) => tab.id)).toEqual([
      'overview',
      'access',
    ]);
  });

  it('maps every capability section to exactly one existing tab', () => {
    const tabIds = new Set(API_SERVICE_TABS.map((tab) => tab.id));
    expect(Object.values(API_SERVICE_SECTION_TAB).every((tab) => tabIds.has(tab))).toBe(true);

    const mappedSections = API_SERVICE_TABS.flatMap((tab) => sectionsForApiServiceTab(tab.id));
    expect(new Set(mappedSections).size).toBe(Object.keys(API_SERVICE_SECTION_TAB).length);
  });

  it('keeps overview concise and no longer carries an endpoint-routing tab', () => {
    expect(sectionsForApiServiceTab('overview')).toEqual([
      'serverStatus',
      'serviceControls',
      'queueStatus',
      'bindingCoverage',
      // search-settings-ui: the search-provider settings section rides the
      // overview tab after Images.
      'searchSettings',
    ]);
    expect(sectionsForApiServiceTab('access')).toEqual(['accessKeys', 'vouchers']);
    expect(API_SERVICE_SECTION_TAB).not.toHaveProperty('endpointRouting');
    expect(API_SERVICE_SECTION_TAB).not.toHaveProperty('networkBinding');
    expect(API_SERVICE_SECTION_TAB).not.toHaveProperty('requestQueue');
    expect(API_SERVICE_SECTION_TAB).not.toHaveProperty('upstreamProxy');
    // The live-traffic / activity sections graduated to the Route Activity page.
    expect(API_SERVICE_SECTION_TAB).not.toHaveProperty('liveTrafficQueue');
    expect(API_SERVICE_SECTION_TAB).not.toHaveProperty('recentErrors');
  });

  it('normalizes old in-memory callers while hashes redirect at the route boundary', () => {
    expect(normalizeApiServiceTab('status')).toBe('overview');
    // The endpoint-routing tab is gone with the global fallback; old ids land on overview.
    expect(normalizeApiServiceTab('endpoints')).toBe('overview');
    expect(normalizeApiServiceTab('settings')).toBe('overview');
    expect(normalizeApiServiceTab('access-keys')).toBe('access');
  });
});
