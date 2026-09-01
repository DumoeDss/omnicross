import {
  DEFAULT_IMAGE_API_LIMITS,
  type ImageApiLimits,
} from '../image-generation/openai-images/types';

import type { ImagesServerConfig } from './types';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Immutable upper bounds used by both tolerant reads and strict admin writes. */
export const IMAGE_SERVER_HARD_CEILINGS = Object.freeze({
  queue: Object.freeze({
    maxConcurrentJobsPerAccount: 8,
    maxQueuedJobs: 1_000,
    queueTimeoutMs: 10 * 60_000,
    generationTimeoutMs: 10 * 60_000,
  }),
  temporary: Object.freeze({
    maxActiveScopes: 256,
    maxTotalBytes: 16 * GIB,
    maxTenantBytes: 4 * GIB,
    staleAfterMs: 24 * 60 * 60_000,
    cleanupIntervalMs: 60 * 60_000,
  }),
  limits: Object.freeze<ImageApiLimits>({
    maxJsonBytes: 128 * MIB,
    maxMultipartBytes: GIB,
    maxFileBytes: 50 * MIB,
    maxTotalInputBytes: GIB,
    maxFiles: 17,
    maxFields: 128,
    maxParts: 256,
    maxHeaderPairs: 256,
    maxFieldNameBytes: 1024,
    maxFieldValueBytes: MIB,
    maxPixels: 8_294_400,
    maxRawBytes: 8_294_400 * 4,
    maxOutputBytes: 50 * MIB,
    maxTotalOutputBytes: 500 * MIB,
    maxSpoolBytes: 700 * MIB,
    maxRedirects: 10,
    maxRemoteUrlBytes: 16 * 1024,
    maxRemoteHeaderBytes: 64 * 1024,
    remoteConnectTimeoutMs: 60_000,
    remoteTotalTimeoutMs: 5 * 60_000,
  }),
  references: Object.freeze({
    ttlMs: 30 * 24 * 60 * 60_000,
    maxArtifactBytes: 50 * MIB,
    maxTotalBytes: 64 * GIB,
    maxTenantBytes: 16 * GIB,
    maxEntries: 1_000_000,
    maxCalls: 2_000_000,
    maxResponses: 1_000_000,
    maxTombstones: 2_000_000,
    tombstoneTtlMs: 30 * 24 * 60 * 60_000,
    cleanupIntervalMs: 60 * 60_000,
  }),
  evidenceTtlMs: 7 * 24 * 60 * 60_000,
});

/** Migration-safe default: configured off, finite everywhere, and remote-disabled. */
export const DEFAULT_IMAGES_SERVER_CONFIG: Readonly<ImagesServerConfig> = Object.freeze({
  enabled: false,
  provider: 'codex-subscription',
  defaultModel: 'gpt-image-2',
  modelAliases: Object.freeze({}),
  account: Object.freeze({ fallback: 'strict' }),
  queue: Object.freeze({
    maxConcurrentJobsPerAccount: 1,
    maxQueuedJobs: 20,
    queueTimeoutMs: 120_000,
    generationTimeoutMs: 180_000,
  }),
  temporary: Object.freeze({
    maxActiveScopes: 64,
    maxTotalBytes: GIB,
    maxTenantBytes: 256 * MIB,
    staleAfterMs: 60 * 60_000,
    cleanupIntervalMs: 5 * 60_000,
  }),
  limits: Object.freeze({ ...DEFAULT_IMAGE_API_LIMITS }),
  references: Object.freeze({
    ttlMs: 24 * 60 * 60_000,
    maxArtifactBytes: 50 * MIB,
    maxTotalBytes: 4 * GIB,
    maxTenantBytes: GIB,
    maxEntries: 10_000,
    maxCalls: 20_000,
    maxResponses: 10_000,
    maxTombstones: 20_000,
    tombstoneTtlMs: 24 * 60 * 60_000,
    cleanupIntervalMs: 5 * 60_000,
  }),
  remote: Object.freeze({ enabled: false }),
  evidenceTtlMs: 24 * 60 * 60_000,
});

const LIMIT_KEYS = Object.keys(DEFAULT_IMAGE_API_LIMITS) as Array<keyof ImageApiLimits>;
type MutableImageApiLimits = { -readonly [K in keyof ImageApiLimits]: ImageApiLimits[K] };
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedInt(value: unknown, fallback: number, ceiling: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, ceiling)
    : fallback;
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(trimmed)
    ? trimmed
    : undefined;
}

function normalizedAliases(value: unknown): Record<string, string> {
  const aliases: Record<string, string> = {};
  const raw = record(value);
  if (!raw) return aliases;
  for (const [alias, target] of Object.entries(raw)) {
    if (SAFE_OBJECT_KEYS.has(alias) || !MODEL_ID.test(alias)) continue;
    if (typeof target !== 'string' || !MODEL_ID.test(target)) continue;
    aliases[alias] = target;
  }
  return aliases;
}

/** Tolerant read normalization: malformed members fall back or clamp, never throw. */
export function normalizeImagesServerConfig(value: unknown): ImagesServerConfig {
  const raw = record(value) ?? {};
  const accountRaw = record(raw['account']) ?? {};
  const queueRaw = record(raw['queue']) ?? {};
  const temporaryRaw = record(raw['temporary']) ?? {};
  const limitsRaw = record(raw['limits']) ?? {};
  const referencesRaw = record(raw['references']) ?? {};
  const remoteRaw = record(raw['remote']) ?? {};

  const limits = { ...DEFAULT_IMAGES_SERVER_CONFIG.limits } as MutableImageApiLimits;
  for (const key of LIMIT_KEYS) {
    limits[key] = boundedInt(
      limitsRaw[key],
      DEFAULT_IMAGES_SERVER_CONFIG.limits[key],
      IMAGE_SERVER_HARD_CEILINGS.limits[key],
    );
  }
  // 0.2.0 persisted the then-default 1 MiB JSON limit. Codex now submits
  // built-in edits as Base64 JSON, so migrate that exact legacy default while
  // preserving deliberately configured non-default limits.
  if (limitsRaw['maxJsonBytes'] === MIB) {
    limits.maxJsonBytes = DEFAULT_IMAGES_SERVER_CONFIG.limits.maxJsonBytes;
  }
  limits.maxTotalInputBytes = Math.max(limits.maxTotalInputBytes, limits.maxFileBytes);
  limits.maxMultipartBytes = Math.max(limits.maxMultipartBytes, limits.maxTotalInputBytes);
  limits.maxTotalOutputBytes = Math.max(limits.maxTotalOutputBytes, limits.maxOutputBytes);
  limits.maxSpoolBytes = Math.max(
    limits.maxSpoolBytes,
    Math.ceil(limits.maxTotalOutputBytes * 4 / 3),
  );

  const accountId = safeIdentifier(accountRaw['id']);
  const accountGroup = accountId ? undefined : safeIdentifier(accountRaw['group']);
  const account: ImagesServerConfig['account'] = {
    fallback: accountRaw['fallback'] === 'pool' ? 'pool' : 'strict',
  };
  if (accountId) account.id = accountId;
  if (accountGroup) account.group = accountGroup;

  const queue: ImagesServerConfig['queue'] = {
    maxConcurrentJobsPerAccount: boundedInt(
      queueRaw['maxConcurrentJobsPerAccount'],
      DEFAULT_IMAGES_SERVER_CONFIG.queue.maxConcurrentJobsPerAccount,
      IMAGE_SERVER_HARD_CEILINGS.queue.maxConcurrentJobsPerAccount,
    ),
    maxQueuedJobs: boundedInt(
      queueRaw['maxQueuedJobs'],
      DEFAULT_IMAGES_SERVER_CONFIG.queue.maxQueuedJobs,
      IMAGE_SERVER_HARD_CEILINGS.queue.maxQueuedJobs,
    ),
    queueTimeoutMs: boundedInt(
      queueRaw['queueTimeoutMs'],
      DEFAULT_IMAGES_SERVER_CONFIG.queue.queueTimeoutMs,
      IMAGE_SERVER_HARD_CEILINGS.queue.queueTimeoutMs,
    ),
    generationTimeoutMs: boundedInt(
      queueRaw['generationTimeoutMs'],
      DEFAULT_IMAGES_SERVER_CONFIG.queue.generationTimeoutMs,
      IMAGE_SERVER_HARD_CEILINGS.queue.generationTimeoutMs,
    ),
  };

  const temporary: ImagesServerConfig['temporary'] = {
    maxActiveScopes: boundedInt(
      temporaryRaw['maxActiveScopes'],
      DEFAULT_IMAGES_SERVER_CONFIG.temporary.maxActiveScopes,
      IMAGE_SERVER_HARD_CEILINGS.temporary.maxActiveScopes,
    ),
    maxTotalBytes: boundedInt(
      temporaryRaw['maxTotalBytes'],
      DEFAULT_IMAGES_SERVER_CONFIG.temporary.maxTotalBytes,
      IMAGE_SERVER_HARD_CEILINGS.temporary.maxTotalBytes,
    ),
    maxTenantBytes: boundedInt(
      temporaryRaw['maxTenantBytes'],
      DEFAULT_IMAGES_SERVER_CONFIG.temporary.maxTenantBytes,
      IMAGE_SERVER_HARD_CEILINGS.temporary.maxTenantBytes,
    ),
    staleAfterMs: boundedInt(
      temporaryRaw['staleAfterMs'],
      DEFAULT_IMAGES_SERVER_CONFIG.temporary.staleAfterMs,
      IMAGE_SERVER_HARD_CEILINGS.temporary.staleAfterMs,
    ),
    cleanupIntervalMs: boundedInt(
      temporaryRaw['cleanupIntervalMs'],
      DEFAULT_IMAGES_SERVER_CONFIG.temporary.cleanupIntervalMs,
      IMAGE_SERVER_HARD_CEILINGS.temporary.cleanupIntervalMs,
    ),
  };
  temporary.maxTenantBytes = Math.max(temporary.maxTenantBytes, limits.maxMultipartBytes, limits.maxSpoolBytes);
  temporary.maxTotalBytes = Math.max(temporary.maxTotalBytes, temporary.maxTenantBytes);
  temporary.staleAfterMs = Math.max(
    temporary.staleAfterMs,
    queue.queueTimeoutMs + queue.generationTimeoutMs,
  );
  temporary.cleanupIntervalMs = Math.min(temporary.cleanupIntervalMs, temporary.staleAfterMs);

  const references: ImagesServerConfig['references'] = {
    ttlMs: boundedInt(
      referencesRaw['ttlMs'],
      DEFAULT_IMAGES_SERVER_CONFIG.references.ttlMs,
      IMAGE_SERVER_HARD_CEILINGS.references.ttlMs,
    ),
    maxArtifactBytes: boundedInt(
      referencesRaw['maxArtifactBytes'],
      DEFAULT_IMAGES_SERVER_CONFIG.references.maxArtifactBytes,
      IMAGE_SERVER_HARD_CEILINGS.references.maxArtifactBytes,
    ),
    maxTotalBytes: boundedInt(
      referencesRaw['maxTotalBytes'],
      DEFAULT_IMAGES_SERVER_CONFIG.references.maxTotalBytes,
      IMAGE_SERVER_HARD_CEILINGS.references.maxTotalBytes,
    ),
    maxTenantBytes: boundedInt(
      referencesRaw['maxTenantBytes'],
      DEFAULT_IMAGES_SERVER_CONFIG.references.maxTenantBytes,
      IMAGE_SERVER_HARD_CEILINGS.references.maxTenantBytes,
    ),
    maxEntries: boundedInt(
      referencesRaw['maxEntries'],
      DEFAULT_IMAGES_SERVER_CONFIG.references.maxEntries,
      IMAGE_SERVER_HARD_CEILINGS.references.maxEntries,
    ),
    maxCalls: boundedInt(
      referencesRaw['maxCalls'],
      DEFAULT_IMAGES_SERVER_CONFIG.references.maxCalls,
      IMAGE_SERVER_HARD_CEILINGS.references.maxCalls,
    ),
    maxResponses: boundedInt(
      referencesRaw['maxResponses'],
      DEFAULT_IMAGES_SERVER_CONFIG.references.maxResponses,
      IMAGE_SERVER_HARD_CEILINGS.references.maxResponses,
    ),
    maxTombstones: boundedInt(
      referencesRaw['maxTombstones'],
      DEFAULT_IMAGES_SERVER_CONFIG.references.maxTombstones,
      IMAGE_SERVER_HARD_CEILINGS.references.maxTombstones,
    ),
    tombstoneTtlMs: boundedInt(
      referencesRaw['tombstoneTtlMs'],
      DEFAULT_IMAGES_SERVER_CONFIG.references.tombstoneTtlMs,
      IMAGE_SERVER_HARD_CEILINGS.references.tombstoneTtlMs,
    ),
    cleanupIntervalMs: boundedInt(
      referencesRaw['cleanupIntervalMs'],
      DEFAULT_IMAGES_SERVER_CONFIG.references.cleanupIntervalMs,
      IMAGE_SERVER_HARD_CEILINGS.references.cleanupIntervalMs,
    ),
  };
  references.maxArtifactBytes = Math.min(references.maxArtifactBytes, limits.maxOutputBytes);
  references.maxTenantBytes = Math.max(references.maxTenantBytes, references.maxArtifactBytes);
  references.maxTotalBytes = Math.max(references.maxTotalBytes, references.maxTenantBytes);
  references.cleanupIntervalMs = Math.min(
    references.cleanupIntervalMs,
    references.ttlMs,
    references.tombstoneTtlMs,
  );
  if (typeof referencesRaw['storageRoot'] === 'string' && referencesRaw['storageRoot'].trim()) {
    references.storageRoot = referencesRaw['storageRoot'].trim();
  }

  const defaultModel = typeof raw['defaultModel'] === 'string' && MODEL_ID.test(raw['defaultModel'])
    ? raw['defaultModel']
    : DEFAULT_IMAGES_SERVER_CONFIG.defaultModel;
  const aliases = normalizedAliases(raw['modelAliases']);
  for (const alias of Object.keys(aliases)) {
    if (aliases[alias] !== defaultModel) delete aliases[alias];
  }

  return {
    enabled: raw['enabled'] === true,
    provider: 'codex-subscription',
    defaultModel,
    modelAliases: aliases,
    account,
    queue,
    temporary,
    limits,
    references,
    remote: { enabled: remoteRaw['enabled'] === true },
    evidenceTtlMs: boundedInt(
      raw['evidenceTtlMs'],
      DEFAULT_IMAGES_SERVER_CONFIG.evidenceTtlMs,
      IMAGE_SERVER_HARD_CEILINGS.evidenceTtlMs,
    ),
  };
}

const TOP_LEVEL_KEYS = [
  'enabled', 'provider', 'defaultModel', 'modelAliases', 'account', 'queue',
  'temporary', 'limits', 'references', 'remote', 'evidenceTtlMs',
] as const;
const ACCOUNT_KEYS = ['id', 'group', 'fallback'] as const;
const QUEUE_KEYS = [
  'maxConcurrentJobsPerAccount', 'maxQueuedJobs', 'queueTimeoutMs', 'generationTimeoutMs',
] as const;
const TEMPORARY_KEYS = [
  'maxActiveScopes', 'maxTotalBytes', 'maxTenantBytes', 'staleAfterMs', 'cleanupIntervalMs',
] as const;
const REFERENCE_KEYS = [
  'ttlMs', 'maxArtifactBytes', 'maxTotalBytes', 'maxTenantBytes', 'maxEntries',
  'maxCalls', 'maxResponses', 'maxTombstones', 'tombstoneTtlMs', 'cleanupIntervalMs',
  'storageRoot',
] as const;

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key} is not supported`);
  }
}

function requireRecord(
  value: unknown,
  path: string,
  errors: string[],
): Record<string, unknown> | undefined {
  const result = record(value);
  if (!result) errors.push(`${path} must be an object`);
  return result;
}

function strictInteger(
  value: unknown,
  ceiling: number,
  path: string,
  errors: string[],
): value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > ceiling) {
    errors.push(`${path} must be a positive safe integer no greater than ${ceiling}`);
    return false;
  }
  return true;
}

/** Strict structural/range validation. Daemon validation adds filesystem and resolver policy. */
export function validateImagesServerConfig(value: unknown): string[] {
  const errors: string[] = [];
  const raw = requireRecord(value, 'images', errors);
  if (!raw) return errors;
  rejectUnknown(raw, TOP_LEVEL_KEYS, 'images', errors);

  if (typeof raw['enabled'] !== 'boolean') errors.push('images.enabled must be a boolean');
  if (raw['provider'] !== 'codex-subscription') {
    errors.push("images.provider must be 'codex-subscription'");
  }
  if (raw['defaultModel'] !== 'gpt-image-2') {
    errors.push("images.defaultModel must be 'gpt-image-2'");
  }

  const aliases = requireRecord(raw['modelAliases'], 'images.modelAliases', errors);
  if (aliases) {
    for (const [alias, target] of Object.entries(aliases)) {
      if (SAFE_OBJECT_KEYS.has(alias) || !MODEL_ID.test(alias)) {
        errors.push('images.modelAliases contains an invalid alias');
      }
      if (target !== raw['defaultModel']) {
        errors.push(`images.modelAliases.${alias} must target the configured default model`);
      }
    }
  }

  const account = requireRecord(raw['account'], 'images.account', errors);
  if (account) {
    rejectUnknown(account, ACCOUNT_KEYS, 'images.account', errors);
    const id = account['id'];
    const group = account['group'];
    if (id !== undefined && safeIdentifier(id) === undefined) errors.push('images.account.id is invalid');
    if (group !== undefined && safeIdentifier(group) === undefined) errors.push('images.account.group is invalid');
    if (id !== undefined && group !== undefined) {
      errors.push('images.account may select an id or group, not both');
    }
    if (account['fallback'] !== 'strict' && account['fallback'] !== 'pool') {
      errors.push("images.account.fallback must be 'strict' or 'pool'");
    }
  }

  const queue = requireRecord(raw['queue'], 'images.queue', errors);
  if (queue) {
    rejectUnknown(queue, QUEUE_KEYS, 'images.queue', errors);
    for (const key of QUEUE_KEYS) {
      strictInteger(queue[key], IMAGE_SERVER_HARD_CEILINGS.queue[key], `images.queue.${key}`, errors);
    }
  }

  const temporary = requireRecord(raw['temporary'], 'images.temporary', errors);
  if (temporary) {
    rejectUnknown(temporary, TEMPORARY_KEYS, 'images.temporary', errors);
    for (const key of TEMPORARY_KEYS) {
      strictInteger(
        temporary[key],
        IMAGE_SERVER_HARD_CEILINGS.temporary[key],
        `images.temporary.${key}`,
        errors,
      );
    }
  }

  const limits = requireRecord(raw['limits'], 'images.limits', errors);
  if (limits) {
    rejectUnknown(limits, LIMIT_KEYS, 'images.limits', errors);
    for (const key of LIMIT_KEYS) {
      strictInteger(limits[key], IMAGE_SERVER_HARD_CEILINGS.limits[key], `images.limits.${key}`, errors);
    }
  }

  const references = requireRecord(raw['references'], 'images.references', errors);
  if (references) {
    rejectUnknown(references, REFERENCE_KEYS, 'images.references', errors);
    for (const key of REFERENCE_KEYS.filter((entry) => entry !== 'storageRoot')) {
      const numberKey = key as Exclude<typeof REFERENCE_KEYS[number], 'storageRoot'>;
      strictInteger(
        references[numberKey],
        IMAGE_SERVER_HARD_CEILINGS.references[numberKey],
        `images.references.${numberKey}`,
        errors,
      );
    }
    if (
      references['storageRoot'] !== undefined &&
      (typeof references['storageRoot'] !== 'string' || !references['storageRoot'].trim())
    ) {
      errors.push('images.references.storageRoot must be a non-empty path when provided');
    }
  }

  const remote = requireRecord(raw['remote'], 'images.remote', errors);
  if (remote) {
    rejectUnknown(remote, ['enabled'], 'images.remote', errors);
    if (typeof remote['enabled'] !== 'boolean') errors.push('images.remote.enabled must be a boolean');
  }
  strictInteger(
    raw['evidenceTtlMs'],
    IMAGE_SERVER_HARD_CEILINGS.evidenceTtlMs,
    'images.evidenceTtlMs',
    errors,
  );

  if (limits) {
    if (Number(limits['maxTotalInputBytes']) < Number(limits['maxFileBytes'])) {
      errors.push('images.limits.maxTotalInputBytes must cover maxFileBytes');
    }
    if (Number(limits['maxMultipartBytes']) < Number(limits['maxTotalInputBytes'])) {
      errors.push('images.limits.maxMultipartBytes must cover maxTotalInputBytes');
    }
    if (Number(limits['maxTotalOutputBytes']) < Number(limits['maxOutputBytes'])) {
      errors.push('images.limits.maxTotalOutputBytes must cover maxOutputBytes');
    }
    if (Number(limits['maxSpoolBytes']) < Math.ceil(Number(limits['maxTotalOutputBytes']) * 4 / 3)) {
      errors.push('images.limits.maxSpoolBytes must cover Base64 aggregate output');
    }
  }
  if (temporary && limits) {
    if (Number(temporary['maxTenantBytes']) < Number(limits['maxMultipartBytes']) ||
        Number(temporary['maxTenantBytes']) < Number(limits['maxSpoolBytes'])) {
      errors.push('images.temporary.maxTenantBytes must cover one request input and output spool');
    }
    if (Number(temporary['maxTotalBytes']) < Number(temporary['maxTenantBytes'])) {
      errors.push('images.temporary.maxTotalBytes must cover maxTenantBytes');
    }
    if (Number(temporary['cleanupIntervalMs']) > Number(temporary['staleAfterMs'])) {
      errors.push('images.temporary.cleanupIntervalMs must not exceed staleAfterMs');
    }
  }
  if (temporary && queue && Number(temporary['staleAfterMs']) <
    Number(queue['queueTimeoutMs']) + Number(queue['generationTimeoutMs'])) {
    errors.push('images.temporary.staleAfterMs must cover queue and generation timeouts');
  }
  if (references) {
    if (Number(references['maxTenantBytes']) < Number(references['maxArtifactBytes'])) {
      errors.push('images.references.maxTenantBytes must cover maxArtifactBytes');
    }
    if (Number(references['maxTotalBytes']) < Number(references['maxTenantBytes'])) {
      errors.push('images.references.maxTotalBytes must cover maxTenantBytes');
    }
    if (Number(references['cleanupIntervalMs']) > Number(references['ttlMs']) ||
        Number(references['cleanupIntervalMs']) > Number(references['tombstoneTtlMs'])) {
      errors.push('images.references.cleanupIntervalMs must not exceed either TTL');
    }
  }

  return errors;
}
