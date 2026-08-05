import { describe, expect, it } from 'vitest';

import en from '../en.json';
import zh from '../zh.json';
import zhHant from '../zh-Hant.json';

const gatewayTabs = ['overview', 'access', 'activity', 'settings'];
const settingsTabs = ['general', 'network', 'security', 'data', 'notifications', 'advanced', 'billing', 'pricing'];

describe('Gateway and Settings translations', () => {
  it('provides every canonical task label and moved-settings label in en/zh/zh-Hant', () => {
    for (const locale of [en, zh, zhHant]) {
      const apiTabs = locale.apiService.tabs as Record<string, string>;
      const settings = locale.settings as typeof en.settings;
      const labels = settings.tabs as Record<string, string>;

      expect(locale.apiService.gatewayTitle).toEqual(expect.any(String));
      expect(locale.apiService.gatewayDescription).toEqual(expect.any(String));
      for (const key of gatewayTabs) expect(apiTabs[key]).toEqual(expect.any(String));
      for (const key of settingsTabs) expect(labels[key]).toEqual(expect.any(String));
      expect(settings.network.title).toEqual(expect.any(String));
      expect(settings.security.title).toEqual(expect.any(String));
      expect(settings.data.migrationTitle).toEqual(expect.any(String));
      expect(locale.apiService.liveTraffic.errors.auditOff).toEqual(expect.any(String));
      expect(locale.apiService.endpoint.boundAccountFallbackPolicy).toEqual(expect.any(String));
      expect(locale.apiService.endpoint.boundAccountFallbackStrict).toEqual(expect.any(String));
      expect(locale.apiService.endpoint.boundAccountFallbackPool).toEqual(expect.any(String));
      expect(locale.apiService.endpoint.boundAccountFallbackStrictHint).toEqual(expect.any(String));
      expect(locale.apiService.endpoint.boundAccountFallbackPoolHint).toEqual(expect.any(String));
      expect(locale.apiService.globalFallback.title).toEqual(expect.any(String));
      expect(locale.apiService.bindingCoverage.title).toEqual(expect.any(String));
      expect(locale.apiService.keys.bindings.title).toEqual(expect.any(String));
      expect(locale.upstreams.title).toEqual(expect.any(String));
      expect(locale.upstreams.routes.signalPath).toEqual(expect.any(String));
    }
  });
});
