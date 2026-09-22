import { describe, expect, it } from 'vitest';
import { normalizeServerConfig } from '@omnicross/core/outbound-api';

import { resolveUpstreamModelMappings, type UpstreamCatalogEntry } from '../admin/upstreamRoutingAdmin';
import type { DaemonProviderConfig } from '../config';

const providers: DaemonProviderConfig[] = [{
  id: 'z-ai', apiFormat: 'openai', baseUrl: 'https://upstream.test/v1',
  apiKey: '', models: ['glm-5.2', 'glm-5.3'],
}];
const catalog: UpstreamCatalogEntry[] = [
  { key: 'z-ai', label: 'z.ai', target: { kind: 'provider', providerId: 'z-ai' } },
  { key: 'sub:codex', label: 'Codex', target: { kind: 'account-pool', providerId: 'codex' } },
  { key: 'sub:opencodego', label: 'OpenCodeGo', target: { kind: 'account-pool', providerId: 'opencodego' } },
];

describe('effective upstream mapping defaults', () => {
  it('supplies defaults for existing providers and subscription pools without rewriting settings', () => {
    const config = normalizeServerConfig({});
    const tables = resolveUpstreamModelMappings(config, providers, catalog);
    expect(tables['z-ai']).toEqual([{ source: '*', target: 'glm-5.2' }]);
    expect(tables['sub:opencodego']).toEqual([{ source: '*', target: 'deepseek-flash' }]);
    expect(tables['sub:codex']).toContainEqual({ source: '*', target: 'gpt-6-astra' });
    expect(tables['sub:codex']).toContainEqual({ source: 'gpt-5.6-luna', target: 'gpt-5.6-luna' });
    expect(config.upstreamModelMappings).toBeUndefined();
  });

  it('inherits legacy model choices and effort before generating a fallback', () => {
    const config = normalizeServerConfig({ bindings: [{
      id: 'old-route', name: 'Old route', enabled: true, endpoint: 'responses',
      target: catalog[0].target, fallback: 'fail', modelMode: 'mapped',
      modelMappings: [{ source: 'claude-*', target: 'glm-5.3', effort: 'high' }, { source: '*', target: 'glm-5.3' }],
    }] });
    expect(resolveUpstreamModelMappings(config, providers, catalog)['z-ai']).toEqual([
      { source: 'claude-*', target: 'glm-5.3', effort: 'high' }, { source: '*', target: 'glm-5.3' },
    ]);
  });

  it('honors explicit tables and an explicitly cleared table after config normalization', () => {
    const tables = { 'z-ai': [], 'sub:codex': [{ source: '*', target: 'chosen-by-user' }] };
    const config = normalizeServerConfig({ upstreamModelMappings: tables });
    const effective = resolveUpstreamModelMappings(config, providers, catalog);
    expect(effective['z-ai']).toEqual([]);
    expect(effective['sub:codex']).toEqual(tables['sub:codex']);
  });

  it('does not revive a disabled legacy route or invent a model for an unknown pool', () => {
    const config = normalizeServerConfig({ bindings: [{
      id: 'disabled', name: 'Disabled', enabled: false, endpoint: 'responses',
      target: catalog[0].target, modelMode: 'mapped', fallback: 'fail',
      modelMappings: [{ source: '*', target: 'old-disabled-model' }],
    }] });
    const effective = resolveUpstreamModelMappings(config, providers, [
      ...catalog, { key: 'sub:gemini', label: 'Gemini', target: { kind: 'account-pool', providerId: 'gemini' } },
    ]);
    expect(effective['z-ai']).toEqual([{ source: '*', target: 'glm-5.2' }]);
    expect(effective['sub:gemini']).toBeUndefined();
  });
});
