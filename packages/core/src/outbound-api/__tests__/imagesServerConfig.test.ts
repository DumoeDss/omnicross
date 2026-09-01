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
  it('keeps a missing legacy segment disabled with finite frozen defaults', () => {
    const normalized = normalizeServerConfig({
      enabled: true,
      networkBinding: false,
      endpoints: [],
      port: 8765,
    });
    expect(normalized.images).toEqual(DEFAULT_IMAGES_SERVER_CONFIG);
    expect(normalized.images?.enabled).toBe(false);
    expect(normalized.images?.defaultModel).toBe('gpt-image-2');
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
    expect(normalized.provider).toBe('codex-subscription');
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
    expect(merged.images?.defaultModel).toBe('gpt-image-2');
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
    unknown['provider'] = 'other';
    expect(validateImagesServerConfig(unknown).join('\n')).toMatch(/surprise|provider/);

    const ambiguous = validImagesConfig();
    ambiguous['account'] = { id: 'one', group: 'two', fallback: 'random' };
    expect(validateImagesServerConfig(ambiguous).join('\n')).toMatch(/not both|fallback/);

    const alias = validImagesConfig();
    alias['modelAliases'] = { image: 'some-other-model' };
    expect(validateImagesServerConfig(alias).join('\n')).toMatch(/must target/);

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
