import { describe, expect, it } from 'vitest';

import {
  DEFAULT_IMAGES_SERVER_CONFIG,
  IMAGE_SERVER_HARD_CEILINGS,
  normalizeImagesServerConfig,
  validateImagesServerConfig,
} from '../imagesServerConfig';
import { defaultServerConfig, mergeServerConfig, normalizeServerConfig } from '../apiServerConfig';

function validImagesConfig(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(DEFAULT_IMAGES_SERVER_CONFIG)) as Record<string, unknown>;
}

describe('Images server config normalization', () => {
  it('stores a template catalog before any routes exist and round-trips namespaced passthrough routes', () => {
    const provider = { protocol: 'wavespeed' as const, sourceProviderId: 'wave-key', models: ['openai/gpt-image-2.5-sunburst/text-to-image'] };
    const added = { ...validImagesConfig(), providers: { wave: provider } };
    expect(validateImagesServerConfig(added)).toEqual([]);
    expect(normalizeImagesServerConfig(added).providers.wave).toEqual(provider);
    const aliased = { ...added, providers: { wave: { ...provider, modelAliases: { 'gpt-image-2': provider.models[0] } } } };
    expect(validateImagesServerConfig(aliased)).toEqual([]);
    expect(normalizeImagesServerConfig(aliased).providers.wave.modelAliases).toEqual(aliased.providers.wave.modelAliases);
    const model = provider.models[0]!;
    const routed = { ...added, models: { [model]: 'wave' }, defaultModel: model };
    expect(validateImagesServerConfig(routed)).toEqual([]);
    expect(normalizeImagesServerConfig(routed)).toMatchObject({ models: routed.models, defaultModel: model });
    const longModel = 'vendor/' + 'x'.repeat(160);
    expect(validateImagesServerConfig({ ...added, providers: { wave: { ...provider, models: [longModel] } } })).toEqual([]);
    expect(validateImagesServerConfig({ ...added, providers: { wave: { ...provider, models: ['__proto__'] } } }).join(' ')).toContain('valid model ids');
  });
  it('uses Image 2.5 by default and migrates only the untouched subscription default', () => {
    expect(normalizeImagesServerConfig(undefined).defaultModel).toBe('gpt-image-2.5-sunburst');
    const legacy = normalizeImagesServerConfig({ models: { 'gpt-image-2': 'codex-subscription' }, defaultModel: 'gpt-image-2',
      codex: { imageModel: 'gpt-image-2', carrierModel: 'custom-carrier' } });
    expect(legacy.defaultModel).toBe('gpt-image-2.5-sunburst');
    expect(legacy.codex).toEqual({ imageModel: 'gpt-image-2.5-sunburst', carrierModel: 'custom-carrier' });
    const custom = normalizeImagesServerConfig({ providers: { api: { protocol: 'openai-images', sourceProviderId: 'key' } },
      models: { 'gpt-image-2': 'api' }, defaultModel: 'gpt-image-2' });
    expect(custom.defaultModel).toBe('gpt-image-2');
    expect(normalizeImagesServerConfig({ models: { 'gpt-image-2': 'codex-subscription' }, defaultModel: 'gpt-image-2', codex: { imageModel: 'gpt-image-2.5-flare' } }).defaultModel).toBe('gpt-image-2');
  });
  it('drops orphan model mappings so tolerant reads can be saved again', () => {
    const config = normalizeImagesServerConfig({ providers: {
      api: { protocol: 'openai-images', sourceProviderId: 'stored', modelMap: { current: 'gpt-image-2.5-flare', removed: 'gpt-image-2' } },
    }, models: { current: 'api' }, defaultModel: 'current' });
    expect(config.providers.api.modelMap).toEqual({ current: 'gpt-image-2.5-flare' });
    expect(validateImagesServerConfig(config)).toEqual([]);
  });
  it('round-trips an API-only instance without leaking credentials into image config', () => {
    const input = { ...validImagesConfig(), providers: { api: { protocol: 'openrouter', sourceProviderId: 'stored-provider',
      modelMap: { banana: 'google/gemini-nano-banana-2.1' } } }, models: { banana: 'api' }, defaultModel: 'banana' };
    expect(validateImagesServerConfig(input)).toEqual([]);
    expect(normalizeImagesServerConfig(input)).toMatchObject({ providers: input.providers, models: input.models, defaultModel: 'banana' });
    expect(validateImagesServerConfig({ ...input, providers: { api: { ...input.providers.api, apiKey: 'forbidden' } } }).join('\n'))
      .toContain('apiKey is not supported');
  });

  it('migrates retired subscription routes, default and aliases while preserving custom API ids', () => {
    const migrated = normalizeImagesServerConfig({ models: { 'gemini-3-pro-image-preview': 'antigravity-subscription' },
      defaultModel: 'gemini-3-pro-image-preview', aliases: { favorite: 'gemini-3-pro-image-preview' } });
    expect(migrated.models).toEqual({ 'gemini-3-pro-image': 'antigravity-subscription' });
    expect(migrated.defaultModel).toBe('gemini-3-pro-image');
    expect(migrated.aliases).toEqual({ favorite: 'gemini-3-pro-image' });
    const custom = normalizeImagesServerConfig({ providers: { api: { protocol: 'gemini', sourceProviderId: 'source' } },
      models: { 'gemini-3-pro-image-preview': 'api' } });
    expect(custom.models).toEqual({ 'gemini-3-pro-image-preview': 'api' });
  });

  it('routes both Image 2.5 variants and upgrades the former shipped table', () => {
    const defaults = normalizeImagesServerConfig(undefined);
    expect(defaults.models['gpt-image-2.5-flare']).toBe('codex-subscription');
    expect(defaults.models['gpt-image-2.5-sunburst']).toBe('codex-subscription');
    expect(defaults.models).not.toHaveProperty('gpt-image-2-5');
    const upgraded = normalizeImagesServerConfig({
      models: { 'gpt-image-2-5': 'codex-subscription', custom: 'antigravity-subscription' },
    });
    expect(upgraded.models).toMatchObject({
      'gpt-image-2.5-flare': 'codex-subscription',
      'gpt-image-2.5-sunburst': 'codex-subscription',
      custom: 'antigravity-subscription',
    });
    expect(normalizeImagesServerConfig({ models: { custom: 'codex-subscription' } }).models)
      .toEqual({ custom: 'codex-subscription' });
  });

  it('keeps a missing legacy segment disabled with finite frozen defaults', () => {
    const normalized = normalizeServerConfig({
      enabled: true,
      networkBinding: false,
      endpoints: [],
      port: 8765,
    });
    expect(normalized.images).toEqual(DEFAULT_IMAGES_SERVER_CONFIG);
    expect(normalized.images?.enabled).toBe(false);
    expect(normalized.images?.defaultModel).toBe('gpt-image-2.5-sunburst');
    expect(normalized.images?.queue).toMatchObject({
      maxConcurrentJobsPerAccount: 1,
      maxQueuedJobs: 20,
      queueTimeoutMs: 120_000,
      generationTimeoutMs: 180_000,
    });
    expect(normalized.images?.remote.enabled).toBe(false);
    expect(normalized.images?.references.ttlMs).toBe(86_400_000);
  });

  it('tolerates malformed legacy members by falling back, clamping, and repairing aggregates', () => {
    const normalized = normalizeImagesServerConfig({
      enabled: 'yes',
      provider: 'unknown',
      defaultModel: '',
      modelAliases: { good: 'gpt-image-2', bad: 4, constructor: 'gpt-image-2' },
      account: { id: ' account ', group: 'ambiguous', fallback: 'unknown' },
      queue: { maxQueuedJobs: -1, generationTimeoutMs: Number.MAX_SAFE_INTEGER },
      temporary: { maxTenantBytes: 1, maxTotalBytes: 1, cleanupIntervalMs: 99_999, staleAfterMs: 10 },
      limits: { maxFileBytes: 1024, maxTotalInputBytes: 1, maxMultipartBytes: 1 },
      references: { maxArtifactBytes: 4096, maxTenantBytes: 1, maxTotalBytes: 1 },
      remote: { enabled: true },
      evidenceTtlMs: 0,
    });
    expect(normalized.enabled).toBe(false);
    // An unrecognized legacy provider falls to the pinned default routing table.
    expect(normalized.models).toEqual(DEFAULT_IMAGES_SERVER_CONFIG.models);
    expect(normalized.models['gpt-image-2']).toBe('codex-subscription');
    expect(normalized.models['gemini-3-pro-image']).toBe('antigravity-subscription');
    expect(normalized.codex).toEqual({ imageModel: 'gpt-image-2.5-sunburst', carrierModel: 'gpt-5.6-luna' });
    expect(normalized.account).toEqual({ id: 'account', fallback: 'strict' });
    expect(normalized.queue.maxQueuedJobs).toBe(DEFAULT_IMAGES_SERVER_CONFIG.queue.maxQueuedJobs);
    expect(normalized.queue.generationTimeoutMs)
      .toBe(IMAGE_SERVER_HARD_CEILINGS.queue.generationTimeoutMs);
    expect(normalized.limits.maxTotalInputBytes).toBeGreaterThanOrEqual(normalized.limits.maxFileBytes);
    expect(normalized.limits.maxMultipartBytes).toBeGreaterThanOrEqual(normalized.limits.maxTotalInputBytes);
    expect(normalized.temporary.maxTenantBytes).toBeGreaterThanOrEqual(normalized.limits.maxSpoolBytes);
    expect(normalized.temporary.maxTotalBytes).toBeGreaterThanOrEqual(normalized.temporary.maxTenantBytes);
    expect(normalized.temporary.cleanupIntervalMs).toBeLessThanOrEqual(normalized.temporary.staleAfterMs);
    expect(normalized.temporary.staleAfterMs).toBeGreaterThanOrEqual(
      normalized.queue.queueTimeoutMs + normalized.queue.generationTimeoutMs,
    );
    expect(normalized.references.maxTenantBytes)
      .toBeGreaterThanOrEqual(normalized.references.maxArtifactBytes);
    expect(normalized.references.maxTotalBytes)
      .toBeGreaterThanOrEqual(normalized.references.maxTenantBytes);
    expect(normalized.evidenceTtlMs).toBe(DEFAULT_IMAGES_SERVER_CONFIG.evidenceTtlMs);
  });

  it('replaces Images as one normalized nested segment during merge', () => {
    const current = defaultServerConfig();
    const images = validImagesConfig();
    images['enabled'] = true;
    const merged = mergeServerConfig(current, { images: images as never });
    expect(merged.images?.enabled).toBe(true);
    expect(merged.images?.defaultModel).toBe('gpt-image-2.5-sunburst');
  });

  it('migrates the persisted 0.2.0 JSON limit used before Codex JSON edits', () => {
    const normalized = normalizeImagesServerConfig({
      ...validImagesConfig(),
      limits: {
        ...(validImagesConfig()['limits'] as Record<string, number>),
        maxJsonBytes: 1024 * 1024,
      },
    });
    expect(normalized.limits.maxJsonBytes)
      .toBe(DEFAULT_IMAGES_SERVER_CONFIG.limits.maxJsonBytes);
  });
});

describe('strict Images server config validation', () => {
  it('accepts the complete normalized default', () => {
    expect(validateImagesServerConfig(validImagesConfig())).toEqual([]);
  });

  it('rejects unknown fields/providers, ambiguous accounts, aliases, and unsafe ranges', () => {
    const unknown = validImagesConfig();
    unknown['surprise'] = true;
    unknown['provider'] = 'codex-subscription';
    expect(validateImagesServerConfig(unknown).join('\n')).toMatch(/surprise|provider/);

    const badRoute = validImagesConfig();
    (badRoute['models'] as Record<string, unknown>)['mystery-model'] = 'not-a-provider';
    expect(validateImagesServerConfig(badRoute).join('\n')).toMatch(/must target a registered image provider/);

    const badDefault = validImagesConfig();
    badDefault['defaultModel'] = 'unrouted-model';
    expect(validateImagesServerConfig(badDefault).join('\n')).toMatch(/key of images.models/);

    const badCodex = validImagesConfig();
    (badCodex['codex'] as Record<string, unknown>)['imageModel'] = 7;
    expect(validateImagesServerConfig(badCodex).join('\n')).toMatch(/codex.imageModel/);

    const ambiguous = validImagesConfig();
    ambiguous['account'] = { id: 'one', group: 'two', fallback: 'random' };
    expect(validateImagesServerConfig(ambiguous).join('\n')).toMatch(/not both|fallback/);

    const alias = validImagesConfig();
    alias['aliases'] = { image: 'unrouted-model' };
    expect(validateImagesServerConfig(alias).join('\n')).toMatch(/must target a key of images.models/);

    const range = validImagesConfig();
    (range['queue'] as Record<string, unknown>)['maxQueuedJobs'] = 1.5;
    (range['limits'] as Record<string, unknown>)['maxFileBytes'] =
      IMAGE_SERVER_HARD_CEILINGS.limits.maxFileBytes + 1;
    expect(validateImagesServerConfig(range).join('\n')).toMatch(/positive safe integer/);
  });

  it('rejects inconsistent aggregate budgets and cleanup/TTL relationships', () => {
    const value = validImagesConfig();
    const limits = value['limits'] as Record<string, number>;
    limits.maxTotalInputBytes = limits.maxFileBytes - 1;
    limits.maxTotalOutputBytes = limits.maxOutputBytes - 1;
    const temporary = value['temporary'] as Record<string, number>;
    temporary.maxTotalBytes = temporary.maxTenantBytes - 1;
    temporary.cleanupIntervalMs = temporary.staleAfterMs + 1;
    const references = value['references'] as Record<string, number>;
    references.maxTotalBytes = references.maxTenantBytes - 1;
    references.cleanupIntervalMs = references.ttlMs + 1;

    const errors = validateImagesServerConfig(value).join('\n');
    expect(errors).toMatch(/maxTotalInputBytes/);
    expect(errors).toMatch(/maxTotalOutputBytes/);
    expect(errors).toMatch(/temporary.maxTotalBytes/);
    expect(errors).toMatch(/staleAfterMs/);
    expect(errors).toMatch(/references.maxTotalBytes/);
    expect(errors).toMatch(/either TTL/);
  });

  it('requires stale temporary cleanup to cover the longest admitted request lifetime', () => {
    const value = validImagesConfig();
    const queue = value['queue'] as Record<string, number>;
    const temporary = value['temporary'] as Record<string, number>;
    temporary.staleAfterMs = queue.queueTimeoutMs + queue.generationTimeoutMs - 1;
    temporary.cleanupIntervalMs = 1;
    expect(validateImagesServerConfig(value).join('\n'))
      .toMatch(/staleAfterMs must cover queue and generation timeouts/);
  });
});
