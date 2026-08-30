import { createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import type {
  ImageBackground,
  ImageCapabilityValues,
  ImageModeration,
  ImageOutputFormat,
  ImageQuality,
} from '@omnicross/contracts/image-generation-types';
import { IMAGE_SERVER_HARD_CEILINGS } from '@omnicross/core/outbound-api';
import type {
  CodexImageCapabilityEvidence,
  CodexImageCapabilityEvidenceRequest,
  CodexImageCapabilityEvidenceSource,
  CodexImageCapabilityObservation,
  CodexImageCapabilityObservedResponseFields,
} from '@omnicross/subscriptions';

import type { DaemonImagePathResolver } from './imagePathResolver';
import { loadOrCreateImageTenantHmacSalt } from './imageTenantHmac';

const MANIFEST_VERSION = 1;
const MANIFEST_NAME = 'codex-image-capability-evidence.v1.json';
const SOURCE_VERSION = 'codex-image-live-verifier-v1';
const ACCOUNT_DOMAIN = Buffer.from('omnicross:codex-image-evidence:account:v1\0', 'utf8');
const ACCOUNT_KEY = /^[a-f0-9]{64}$/u;
const SIZE = /^(?:auto|[1-9][0-9]{1,4}x[1-9][0-9]{1,4})$/u;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

/**
 * Process-independent physical retention envelope. Every accepted logical
 * evidence TTL is bounded by this authoritative configuration ceiling, so a
 * manifest written by any daemon/doctor process remains safe for every view.
 */
const PHYSICAL_RETENTION_TTL_MS = IMAGE_SERVER_HARD_CEILINGS.evidenceTtlMs;

export interface FileCodexImageCapabilityEvidenceManifestOwnerOptions {
  readonly paths: DaemonImagePathResolver;
  readonly maxEntries?: number;
  readonly now?: () => number;
  readonly random?: (bytes: number) => Buffer;
  readonly hmacSalt?: Uint8Array;
  readonly replaceManifest?: (targetPath: string, contents: Uint8Array) => void;
}

export type FileCodexImageCapabilityEvidenceSourceOptions = Readonly<
  | (FileCodexImageCapabilityEvidenceManifestOwnerOptions & { readonly ttlMs: number })
  | {
      readonly owner: FileCodexImageCapabilityEvidenceManifestOwner;
      readonly ttlMs: number;
    }
>;

export interface FileCodexImageCapabilityEvidenceStatus {
  readonly entries: number;
  readonly freshEntries: number;
  readonly staleEntries: number;
  readonly bytes: number;
}

interface PersistedTestedRequest {
  readonly action: 'generate';
  readonly n: 1;
  readonly quality: ImageQuality;
  readonly size: string;
  readonly background: ImageBackground;
  readonly outputFormat: ImageOutputFormat;
  readonly moderation: ImageModeration;
  readonly stream: false;
  readonly partialImages: 0;
  readonly outputCompression?: number;
}

interface PersistedEvidenceEntry {
  readonly accountKey: string;
  readonly provider: 'codex-subscription';
  readonly model: 'gpt-image-2';
  readonly tested: PersistedTestedRequest;
  readonly responseFields?: CodexImageCapabilityObservedResponseFields;
  readonly sourceVersion: typeof SOURCE_VERSION;
  readonly verifiedAt: number;
  readonly expiresAt: number;
}

interface PersistedEvidenceManifest {
  readonly version: typeof MANIFEST_VERSION;
  readonly revision: number;
  readonly entries: readonly PersistedEvidenceEntry[];
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allow = new Set(allowed);
  return Object.keys(value).every((key) => allow.has(key));
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validTestedRequest(value: unknown): value is PersistedTestedRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, [
    'action', 'n', 'quality', 'size', 'background', 'outputFormat', 'moderation',
    'stream', 'partialImages', 'outputCompression',
  ])) return false;
  const compression = row.outputCompression;
  return row.action === 'generate' && row.n === 1 &&
    ['auto', 'low', 'medium', 'high'].includes(row.quality as string) &&
    typeof row.size === 'string' && SIZE.test(row.size) &&
    ['auto', 'opaque', 'transparent'].includes(row.background as string) &&
    ['png', 'jpeg', 'webp'].includes(row.outputFormat as string) &&
    ['auto', 'low'].includes(row.moderation as string) &&
    row.stream === false && row.partialImages === 0 &&
    (compression === undefined || (
      Number.isSafeInteger(compression) && Number(compression) >= 0 && Number(compression) <= 100 &&
      (row.outputFormat === 'jpeg' || row.outputFormat === 'webp')
    ));
}

function validResponseFields(
  value: unknown,
): value is CodexImageCapabilityObservedResponseFields | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return exactKeys(row, ['usage', 'revisedPrompt']) &&
    (row.usage === undefined || row.usage === true) &&
    (row.revisedPrompt === undefined || row.revisedPrompt === true) &&
    (row.usage === true || row.revisedPrompt === true);
}

function validEntry(value: unknown): value is PersistedEvidenceEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return exactKeys(row, [
    'accountKey', 'provider', 'model', 'tested', 'responseFields', 'sourceVersion',
    'verifiedAt', 'expiresAt',
  ]) &&
    typeof row.accountKey === 'string' && ACCOUNT_KEY.test(row.accountKey) &&
    row.provider === 'codex-subscription' && row.model === 'gpt-image-2' &&
    validTestedRequest(row.tested) && validResponseFields(row.responseFields) &&
    row.sourceVersion === SOURCE_VERSION &&
    safeTimestamp(row.verifiedAt) && safeTimestamp(row.expiresAt) &&
    row.expiresAt > row.verifiedAt &&
    row.verifiedAt <= Number.MAX_SAFE_INTEGER - PHYSICAL_RETENTION_TTL_MS &&
    row.expiresAt <= row.verifiedAt + PHYSICAL_RETENTION_TTL_MS;
}

function validateObservation(value: unknown): asserts value is CodexImageCapabilityObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Codex image capability observation is invalid');
  }
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, ['accountId', 'model', 'request', 'responseFields']) ||
    typeof row.accountId !== 'string' || !row.accountId.trim() || row.accountId.length > 512 ||
    row.model !== 'gpt-image-2' || !validTestedRequest(row.request) ||
    !validResponseFields(row.responseFields)) {
    throw new TypeError('Codex image capability observation is invalid');
  }
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function capabilityValues(entry: PersistedEvidenceEntry): ImageCapabilityValues {
  const compression = entry.tested.outputCompression;
  return Object.freeze({
    available: true,
    models: Object.freeze([entry.model]),
    generate: true,
    edit: false,
    maskEdit: false,
    maxInputImages: 0,
    maxOutputImages: 1,
    streaming: false,
    maxPartialImages: 0,
    transparentBackground: entry.tested.background === 'transparent',
    flexibleSizes: false,
    outputFormats: Object.freeze([entry.tested.outputFormat]),
    qualityLevels: Object.freeze([entry.tested.quality]),
    moderationModes: Object.freeze([entry.tested.moderation]),
    outputCompression: compression === undefined
      ? { supported: false as const }
      : {
          supported: true as const,
          formats: Object.freeze([entry.tested.outputFormat]),
          min: compression,
          max: compression,
        },
    responsesTool: false,
    multiTurnEdit: false,
    supportsFileId: false,
    supportsImageUrl: false,
  });
}

function validateTtlMs(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > PHYSICAL_RETENTION_TTL_MS) {
    throw new TypeError('Codex image evidence TTL must be within the configured hard ceiling');
  }
  return ttlMs;
}

/** Revision-aware manifest owner shared by runtime generations, doctor, and cleanup. */
export class FileCodexImageCapabilityEvidenceManifestOwner {
  readonly #paths: DaemonImagePathResolver;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #random: (bytes: number) => Buffer;
  readonly #salt: Buffer;
  readonly #replaceManifest: (targetPath: string, contents: Uint8Array) => void;
  #revision = 0;
  #entries = new Map<string, PersistedEvidenceEntry>();

  constructor(options: FileCodexImageCapabilityEvidenceManifestOwnerOptions) {
    if (!Number.isSafeInteger(options.maxEntries ?? 256) || (options.maxEntries ?? 256) <= 0) {
      throw new TypeError('Codex image evidence entry limit must be a positive safe integer');
    }
    this.#paths = options.paths;
    this.#maxEntries = options.maxEntries ?? 256;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? randomBytes;
    this.#salt = options.hmacSalt
      ? Buffer.from(options.hmacSalt)
      : loadOrCreateImageTenantHmacSalt(options.paths, this.#random);
    if (this.#salt.byteLength !== 32) {
      throw new TypeError('Codex image evidence HMAC salt is invalid');
    }
    this.#replaceManifest = options.replaceManifest ?? ((target, contents) => {
      this.#atomicReplace(target, contents);
    });
    if (existsSync(this.#manifestPath())) this.#load();
  }

  createSource(ttlMs: number): FileCodexImageCapabilityEvidenceSource {
    return new FileCodexImageCapabilityEvidenceSource({ owner: this, ttlMs });
  }

  async resolveWithTtl(
    request: CodexImageCapabilityEvidenceRequest,
    ttlMs: number,
  ): Promise<CodexImageCapabilityEvidence> {
    validateTtlMs(ttlMs);
    if (request.signal.aborted) throw request.signal.reason;
    this.#refresh();
    const accountKey = this.#accountKey(request.accountId);
    const entry = this.#entries.get(accountKey);
    if (!entry) return this.#unknown();
    const expiresAt = this.#effectiveExpiresAt(entry, ttlMs);
    const common = {
      source: entry.sourceVersion,
      verifiedAt: entry.verifiedAt,
      expiresAt,
    } as const;
    if (expiresAt <= this.#now()) {
      return {
        account: { kind: 'account', ...common },
        upstream: { kind: 'upstream', ...common },
      };
    }
    const values = capabilityValues(entry);
    if (request.signal.aborted) throw request.signal.reason;
    return {
      account: { kind: 'account', ...common, values },
      upstream: { kind: 'upstream', ...common, values },
      ...(entry.responseFields ? { verifiedResponseFields: { ...entry.responseFields } } : {}),
    };
  }

  async recordSuccessfulVerificationWithTtl(
    observation: CodexImageCapabilityObservation,
    ttlMs: number,
  ): Promise<void> {
    validateTtlMs(ttlMs);
    validateObservation(observation);
    this.#refresh();
    const verifiedAt = this.#now();
    if (!safeTimestamp(verifiedAt) ||
      verifiedAt > Number.MAX_SAFE_INTEGER - PHYSICAL_RETENTION_TTL_MS) {
      throw new TypeError('Codex image evidence clock is invalid');
    }
    const accountKey = this.#accountKey(observation.accountId);
    const entry: PersistedEvidenceEntry = {
      accountKey,
      provider: 'codex-subscription',
      model: observation.model,
      tested: { ...observation.request },
      ...(observation.responseFields ? { responseFields: { ...observation.responseFields } } : {}),
      sourceVersion: SOURCE_VERSION,
      verifiedAt,
      // This row is self-sufficient across processes: every writer persists
      // exactly the global allowed logical-TTL envelope.
      expiresAt: verifiedAt + PHYSICAL_RETENTION_TTL_MS,
    };
    const next = new Map(this.#entries);
    next.set(accountKey, entry);
    if (next.size > this.#maxEntries) {
      const victims = [...next.values()]
        .filter((candidate) => candidate.accountKey !== accountKey)
        .sort((a, b) => a.expiresAt - b.expiresAt || a.verifiedAt - b.verifiedAt);
      while (next.size > this.#maxEntries && victims.length > 0) {
        next.delete(victims.shift()!.accountKey);
      }
    }
    this.#persist(next);
    this.#entries = next;
  }

  async cleanup(
    now: number,
    limit: number,
  ): Promise<{ readonly entriesRemoved: number; readonly bytesRemoved: number }> {
    if (!safeTimestamp(now) || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError('Codex image evidence cleanup bounds are invalid');
    }
    this.#refresh();
    const next = new Map(this.#entries);
    const expired = [...next.values()]
      .filter((entry) => entry.expiresAt <= now)
      .sort((a, b) =>
        a.expiresAt - b.expiresAt ||
        a.accountKey.localeCompare(b.accountKey))
      .slice(0, limit);
    if (expired.length === 0) return { entriesRemoved: 0, bytesRemoved: 0 };
    const bytesRemoved = expired.reduce(
      (total, entry) => total + Buffer.byteLength(JSON.stringify(entry), 'utf8'),
      0,
    );
    for (const entry of expired) next.delete(entry.accountKey);
    this.#persist(next);
    this.#entries = next;
    return { entriesRemoved: expired.length, bytesRemoved };
  }

  statusWithTtl(ttlMs: number): FileCodexImageCapabilityEvidenceStatus {
    validateTtlMs(ttlMs);
    this.#refresh();
    const now = this.#now();
    let freshEntries = 0;
    for (const entry of this.#entries.values()) {
      if (this.#effectiveExpiresAt(entry, ttlMs) > now) freshEntries += 1;
    }
    return Object.freeze({
      entries: this.#entries.size,
      freshEntries,
      staleEntries: this.#entries.size - freshEntries,
      bytes: this.#serialized(this.#entries, this.#revision).byteLength,
    });
  }

  #unknown(): CodexImageCapabilityEvidence {
    return {
      account: { kind: 'account', source: 'codex-image-entitlement-unknown' },
      upstream: { kind: 'upstream', source: 'codex-image-protocol-unverified' },
    };
  }

  #accountKey(accountId: string): string {
    if (typeof accountId !== 'string' || !accountId.trim() || accountId.length > 512) {
      throw new TypeError('Codex image evidence account id is invalid');
    }
    return createHmac('sha256', this.#salt)
      .update(ACCOUNT_DOMAIN)
      .update(accountId, 'utf8')
      .digest('hex');
  }

  #effectiveExpiresAt(entry: PersistedEvidenceEntry, ttlMs: number): number {
    return Math.min(entry.expiresAt, entry.verifiedAt + ttlMs);
  }

  #manifestPath(): string {
    return join(this.#paths.verifiedRoot('evidence'), MANIFEST_NAME);
  }

  #serialized(
    entries: ReadonlyMap<string, PersistedEvidenceEntry>,
    revision: number,
  ): Buffer {
    const manifest: PersistedEvidenceManifest = {
      version: MANIFEST_VERSION,
      revision,
      entries: [...entries.values()].sort((a, b) => a.accountKey.localeCompare(b.accountKey)),
    };
    const serialized = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    if (serialized.byteLength > MAX_MANIFEST_BYTES) {
      throw new TypeError('Codex image evidence manifest exceeds its byte bound');
    }
    return serialized;
  }

  #persist(entries: ReadonlyMap<string, PersistedEvidenceEntry>): void {
    const revision = this.#revision + 1;
    this.#replaceManifest(this.#manifestPath(), this.#serialized(entries, revision));
    this.#revision = revision;
  }

  #load(): void {
    const path = this.#manifestPath();
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_MANIFEST_BYTES) {
      throw new TypeError('Codex image evidence manifest is invalid');
    }
    chmodSync(path, 0o600);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('Codex image evidence manifest is invalid');
    }
    const manifest = parsed as Record<string, unknown>;
    if (!exactKeys(manifest, ['version', 'revision', 'entries']) ||
      manifest.version !== MANIFEST_VERSION || !safeTimestamp(manifest.revision) ||
      !Array.isArray(manifest.entries) || manifest.entries.length > this.#maxEntries) {
      throw new TypeError('Codex image evidence manifest is invalid');
    }
    const entries = new Map<string, PersistedEvidenceEntry>();
    for (const value of manifest.entries) {
      if (!validEntry(value) || entries.has(value.accountKey)) {
        throw new TypeError('Codex image evidence manifest contains an invalid entry');
      }
      entries.set(value.accountKey, value);
    }
    this.#revision = manifest.revision;
    this.#entries = entries;
  }

  #refresh(): void {
    if (!existsSync(this.#manifestPath())) return;
    this.#load();
  }

  #atomicReplace(targetPath: string, contents: Uint8Array): void {
    const root = this.#paths.verifiedRoot('evidence');
    if (!samePath(dirname(resolve(targetPath)), root) || basename(targetPath) !== MANIFEST_NAME) {
      throw new TypeError('Codex image evidence manifest target is invalid');
    }
    const temporaryPath = join(
      root,
      `.codex-image-evidence.${process.pid}.${this.#random(8).toString('hex')}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(descriptor, contents);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, targetPath);
      chmodSync(targetPath, 0o600);
    } finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* preserve original failure */ }
      }
      if (existsSync(temporaryPath)) {
        try { unlinkSync(temporaryPath); } catch { /* preserve original failure */ }
      }
    }
  }
}

/** Immutable TTL view over a revision-aware file-backed evidence manifest owner. */
export class FileCodexImageCapabilityEvidenceSource
  implements CodexImageCapabilityEvidenceSource
{
  readonly #owner: FileCodexImageCapabilityEvidenceManifestOwner;
  readonly #ttlMs: number;

  constructor(options: FileCodexImageCapabilityEvidenceSourceOptions) {
    this.#ttlMs = validateTtlMs(options.ttlMs);
    this.#owner = 'owner' in options
      ? options.owner
      : new FileCodexImageCapabilityEvidenceManifestOwner(options);
  }

  createView(ttlMs: number): FileCodexImageCapabilityEvidenceSource {
    return this.#owner.createSource(ttlMs);
  }

  resolve(
    request: CodexImageCapabilityEvidenceRequest,
  ): Promise<CodexImageCapabilityEvidence> {
    return this.#owner.resolveWithTtl(request, this.#ttlMs);
  }

  recordSuccessfulVerification(observation: CodexImageCapabilityObservation): Promise<void> {
    return this.#owner.recordSuccessfulVerificationWithTtl(observation, this.#ttlMs);
  }

  cleanup(
    now: number,
    limit: number,
  ): Promise<{ readonly entriesRemoved: number; readonly bytesRemoved: number }> {
    return this.#owner.cleanup(now, limit);
  }

  status(): FileCodexImageCapabilityEvidenceStatus {
    return this.#owner.statusWithTtl(this.#ttlMs);
  }

  ttlMs(): number {
    return this.#ttlMs;
  }

  /** Lifecycle-symmetric no-op; physical safety no longer depends on local leases. */
  dispose(): void {
    // Every row carries the process-independent bounded retention envelope.
  }
}
