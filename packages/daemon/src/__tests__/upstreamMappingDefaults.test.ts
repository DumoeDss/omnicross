import { describe, expect, it } from 'vitest';
import { normalizeServerConfig } from '@omnicross/core/outbound-api';

import { resolveUpstreamModelMappings, effectiveUpstreamModelMappings, type UpstreamCatalogEntry } from '../admin/upstreamRoutingAdmin';
import { mergeProviderModels } from '../admin/adminApi';
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
    expect(tables['sub:codex']).toContainEqual({ source: 'gpt-6-luna', target: 'gpt-6-luna' });
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

describe('auto (non-force) declared-model passthrough', () => {
  // codex sends fixed names like gpt-6-astra; the provider declares
  // glm-5.2/glm-5.3 with a `* -> glm-5.2` fallback.
  const config = normalizeServerConfig({
    upstreamModelMappings: { 'z-ai': [
      { source: 'claude-*', target: 'glm-5.3' },
      { source: '*', target: 'glm-5.2' },
    ] },
  });

  it('auto prepends identity rows for declared models not named by stored rows', () => {
    const effective = effectiveUpstreamModelMappings(config, providers, catalog);
    expect(effective['z-ai']).toEqual([
      { source: 'glm-5.2', target: 'glm-5.2' },
      { source: 'glm-5.3', target: 'glm-5.3' },
      { source: 'claude-*', target: 'glm-5.3' },
      { source: '*', target: 'glm-5.2' },
    ]);
  });

  it('an explicit exact row wins over the declared-model passthrough', () => {
    const pinned = normalizeServerConfig({
      upstreamModelMappings: { 'z-ai': [{ source: 'glm-5.2', target: 'glm-5.3' }] },
    });
    const effective = effectiveUpstreamModelMappings(pinned, providers, catalog);
    // glm-5.2 has a stored source row → NO identity row for it (the explicit
    // remap wins); the OTHER declared model still gets its passthrough row.
    expect(effective['z-ai']).toEqual([
      { source: 'glm-5.3', target: 'glm-5.3' },
      { source: 'glm-5.2', target: 'glm-5.3' },
    ]);
  });

  it('force serves exactly the stored rows (no derived passthrough)', () => {
    const forced = normalizeServerConfig({ ...config, upstreamModelMappingForce: { 'z-ai': true } });
    const effective = effectiveUpstreamModelMappings(forced, providers, catalog);
    expect(effective['z-ai']).toEqual(config.upstreamModelMappings!['z-ai']);
  });

  it('empty tables stay passthrough (no identity synthesis)', () => {
    const passthrough = normalizeServerConfig({ upstreamModelMappings: { 'z-ai': [] } });
    expect(effectiveUpstreamModelMappings(passthrough, providers, catalog)['z-ai']).toEqual([]);
  });

  it('disabled modelConfigs do not count as declared', () => {
    const withConfigs: DaemonProviderConfig[] = [{
      ...providers[0],
      models: ['glm-5.2'],
      modelConfigs: [{ id: 'glm-5.3', enabled: false }],
    }];
    const effective = effectiveUpstreamModelMappings(config, withConfigs, catalog);
    expect(effective['z-ai']).toContainEqual({ source: 'glm-5.2', target: 'glm-5.2' });
    expect(effective['z-ai']).not.toContainEqual({ source: 'glm-5.3', target: 'glm-5.3' });
  });
});

describe('mergeProviderModels (create-time discovery merge)', () => {
  it('existing order leads; discovered ids append deduped (case-insensitive)', () => {
    expect(mergeProviderModels(['glm-5.2'], ['GLM-5.2', 'glm-5.3', '', 'glm-5.4']))
      .toEqual(['glm-5.2', 'glm-5.3', 'glm-5.4']);
  });

  it('an empty list adopts the discovered ids verbatim', () => {
    expect(mergeProviderModels([], ['deepseek-flash', 'deepseek-v4-pro']))
      .toEqual(['deepseek-flash', 'deepseek-v4-pro']);
  });

  it('a failed discovery ([]) changes nothing', () => {
    expect(mergeProviderModels(['glm-5.2'], [])).toEqual(['glm-5.2']);
    expect(mergeProviderModels(undefined, [])).toEqual([]);
  });
});
