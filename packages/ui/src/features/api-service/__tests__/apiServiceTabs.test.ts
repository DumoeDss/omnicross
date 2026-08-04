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
      'status',
      'routes',
      'access-keys',
      'live-traffic',
    ]);
  });

  it('maps every capability section to exactly one existing tab', () => {
    const tabIds = new Set(API_SERVICE_TABS.map((tab) => tab.id));
    expect(Object.values(API_SERVICE_SECTION_TAB).every((tab) => tabIds.has(tab))).toBe(true);

    const mappedSections = API_SERVICE_TABS.flatMap((tab) => sectionsForApiServiceTab(tab.id));
    expect(new Set(mappedSections).size).toBe(Object.keys(API_SERVICE_SECTION_TAB).length);
  });

  it('keeps status concise and moves operational settings into Settings', () => {
    expect(sectionsForApiServiceTab('status')).toEqual([
      'serverStatus',
      'serviceControls',
      'queueStatus',
    ]);
    expect(sectionsForApiServiceTab('access-keys')).toEqual(['accessKeys', 'vouchers']);
    expect(sectionsForApiServiceTab('live-traffic')).toEqual(['liveTrafficQueue', 'recentErrors']);
    expect(API_SERVICE_SECTION_TAB).not.toHaveProperty('networkBinding');
    expect(API_SERVICE_SECTION_TAB).not.toHaveProperty('requestQueue');
    expect(API_SERVICE_SECTION_TAB).not.toHaveProperty('upstreamProxy');
  });

  it('normalizes old in-memory callers while hashes redirect at the route boundary', () => {
    expect(normalizeApiServiceTab('overview')).toBe('status');
    expect(normalizeApiServiceTab('endpoints')).toBe('routes');
    expect(normalizeApiServiceTab('access')).toBe('access-keys');
  });
});
