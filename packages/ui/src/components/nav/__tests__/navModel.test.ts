import { describe, expect, it } from 'vitest';

import en from '../../../i18n/en.json';
import zh from '../../../i18n/zh.json';
import zhHant from '../../../i18n/zh-Hant.json';

import { MOBILE_MORE_LABEL_KEY, MOBILE_PRIMARY_IDS, NAV_GROUPS } from '../navModel';

describe('navigation model', () => {
  it('groups work by running, configuring and system concerns', () => {
    expect(NAV_GROUPS.map((group) => [group.id, group.items.map((item) => item.id)])).toEqual([
      ['run', ['overview', 'api-service', 'usage-stats']],
      ['configure', ['upstreams', 'integrations']],
      ['system', ['settings']],
    ]);
  });

  it('keeps all six destinations reachable from the compact mobile model', () => {
    const ids = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id));
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect(MOBILE_PRIMARY_IDS).toEqual(['overview', 'api-service', 'upstreams', 'usage-stats']);
    expect(MOBILE_PRIMARY_IDS.every((id) => ids.includes(id))).toBe(true);
  });

  it('uses a localized key for the mobile More affordance in the supported locales', () => {
    expect(MOBILE_MORE_LABEL_KEY).toBe('nav.more');
    for (const locale of [en, zh, zhHant]) {
      expect(locale.nav.more).toEqual(expect.any(String));
      expect(locale.nav.more.trim()).not.toBe('');
    }
  });
});
