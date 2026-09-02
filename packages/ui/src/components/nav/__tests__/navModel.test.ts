import { describe, expect, it } from 'vitest';

import en from '../../../i18n/en.json';
import zh from '../../../i18n/zh.json';
import zhHant from '../../../i18n/zh-Hant.json';

import { MOBILE_MORE_LABEL_KEY, MOBILE_PRIMARY_KEYS, NAV_GROUPS } from '../navModel';

describe('navigation model', () => {
  it('groups work by running, configuring and system concerns', () => {
    expect(NAV_GROUPS.map((group) => [group.id, group.items.map((item) => item.key)])).toEqual([
      ['run', ['overview', 'usage-stats', 'gateway', 'route-activity']],
      // search-settings-tab D1: the Search page is the configure group's first
      // entry — a true sibling of the gateway item, not a section inside it.
      ['configure', ['search', 'upstreams', 'access-keys', 'integrations']],
      ['system', ['settings']],
    ]);
  });

  it('keeps every destination reachable and the mobile keys unique', () => {
    const items = NAV_GROUPS.flatMap((group) => group.items);
    // Unique nav-entry keys …
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
    // … while the gateway page is reached via two entries (overview + access).
    const pages = new Set(items.map((item) => item.page));
    expect(pages).toEqual(new Set(['overview', 'api-service', 'route-activity', 'upstreams', 'integrations', 'search', 'usage-stats', 'settings']));
    expect(items.filter((item) => item.page === 'api-service').map((item) => item.tab)).toEqual(['overview', 'access']);
    // The search entry points at the standalone page with its own label key.
    const search = items.find((item) => item.key === 'search');
    expect(search).toMatchObject({ page: 'search', icon: 'search', labelKey: 'nav.search' });

    expect(MOBILE_PRIMARY_KEYS).toEqual(['overview', 'gateway', 'upstreams', 'usage-stats']);
    expect(MOBILE_PRIMARY_KEYS.every((key) => items.some((item) => item.key === key))).toBe(true);
  });

  it('uses a localized key for the mobile More affordance in the supported locales', () => {
    expect(MOBILE_MORE_LABEL_KEY).toBe('nav.more');
    for (const locale of [en, zh, zhHant]) {
      expect(locale.nav.more).toEqual(expect.any(String));
      expect(locale.nav.more.trim()).not.toBe('');
    }
  });

  it('ships the new gateway-split and route-activity labels in the supported locales', () => {
    for (const locale of [en, zh, zhHant]) {
      for (const key of ['accessKeys', 'routeActivity', 'search'] as const) {
        expect(locale.nav[key]).toEqual(expect.any(String));
        expect((locale.nav[key] as string).trim()).not.toBe('');
      }
      expect(locale.routeActivity.title).toEqual(expect.any(String));
      expect(locale.routeActivity.description).toEqual(expect.any(String));
    }
  });
});
