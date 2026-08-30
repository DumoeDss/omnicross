import { randomBytes } from 'node:crypto';
import {
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

import { ImageGenerationError } from '@omnicross/core/image-generation';
import type {
  ResponsesImageCallBinding,
  ResponsesImageCallId,
  ResponsesImageCallResolution,
  ResponsesImageResponseResolution,
  ResponsesImageStateCommitInput,
  ResponsesImageStateStore,
} from '@omnicross/core/image-generation/responses';

import type { DaemonImagePathResolver } from './imagePathResolver';
import {
  deriveImageTenantHmac,
  isImageTenantHmac,
  loadOrCreateImageTenantHmacSalt,
} from './imageTenantHmac';

const MANIFEST_VERSION = 1;
const MANIFEST_NAME = 'responses-image-state.v1.json';
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const CALL_ID_PATTERN = /^ig_[A-Za-z0-9_-]{16,128}$/u;
const RESPONSE_ID_PATTERN = /^resp_[A-Za-z0-9_-]{1,240}$/u;
const REFERENCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export interface FileResponsesImageStateStoreLimits {
  readonly maxCalls: number;
  readonly maxResponses: number;
  readonly maxTombstones: number;
  readonly tombstoneTtlMs: number;
}

export interface FileResponsesImageStateStoreOptions {
  readonly paths: DaemonImagePathResolver;
  readonly limits: FileResponsesImageStateStoreLimits;
  readonly now?: () => number;
  readonly random?: (bytes: number) => Buffer;
  readonly replaceManifest?: (targetPath: string, contents: Uint8Array) => void;
}

interface PersistedCall {
  readonly callId: string;
  readonly tenantKey: string;
  readonly referenceTenantKey: string;
  readonly referenceId: string;
  readonly expiresAt: number;
  readonly deleted?: true;
}

interface PersistedResponse {
  readonly responseId: string;
  readonly tenantKey: string;
  readonly callIds: readonly string[];
  readonly expiresAt: number;
  readonly deleted?: true;
}

interface PersistedTombstone {
  readonly kind: 'call' | 'response';
  readonly id: string;
  readonly tenantKey: string;
  readonly expiresAt: number;
}

interface PersistedPendingReferenceDelete {
  readonly callId: string;
  readonly referenceTenantKey: string;
  readonly referenceId: string;
  readonly expiresAt: number;
}

export interface PendingResponsesImageReferenceDelete {
  readonly referenceTenantKey: string;
  readonly binding: ResponsesImageCallBinding;
}

interface PersistedManifest {
  readonly version: typeof MANIFEST_VERSION;
  readonly revision: number;
  readonly calls: readonly PersistedCall[];
  readonly responses: readonly PersistedResponse[];
  readonly tombstones: readonly PersistedTombstone[];
  readonly pendingReferenceDeletes: readonly PersistedPendingReferenceDelete[];
}

interface RuntimeCall {
  readonly persisted: PersistedCall;
  activeLeases: number;
}

interface RuntimeResponse {
  readonly persisted: PersistedResponse;
  activeLeases: number;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive.`);
}

function validateLimits(limits: FileResponsesImageStateStoreLimits): void {
  positiveInteger(limits.maxCalls, 'responses image maxCalls');
  positiveInteger(limits.maxResponses, 'responses image maxResponses');
  positiveInteger(limits.maxTombstones, 'responses image maxTombstones');
  positiveInteger(limits.tombstoneTtlMs, 'responses image tombstoneTtlMs');
}

function safeTenant(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function exactKeys(row: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(row).every((key) => allowedKeys.has(key));
}

function validCall(value: unknown): value is PersistedCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return exactKeys(
    row,
    ['callId', 'tenantKey', 'referenceTenantKey', 'referenceId', 'expiresAt', 'deleted'],
  ) &&
    typeof row.callId === 'string' && CALL_ID_PATTERN.test(row.callId) &&
    isImageTenantHmac(row.tenantKey) &&
    isImageTenantHmac(row.referenceTenantKey) &&
    typeof row.referenceId === 'string' && REFERENCE_ID_PATTERN.test(row.referenceId) &&
    safeTimestamp(row.expiresAt) &&
    (row.deleted === undefined || row.deleted === true);
}

function validResponse(value: unknown): value is PersistedResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (
    !exactKeys(row, ['responseId', 'tenantKey', 'callIds', 'expiresAt', 'deleted']) ||
    typeof row.responseId !== 'string' || !RESPONSE_ID_PATTERN.test(row.responseId) ||
    !isImageTenantHmac(row.tenantKey) ||
    !Array.isArray(row.callIds) || row.callIds.length > 10_000 ||
    row.callIds.some((id) => typeof id !== 'string' || !CALL_ID_PATTERN.test(id)) ||
    new Set(row.callIds).size !== row.callIds.length ||
    !safeTimestamp(row.expiresAt) ||
    (row.deleted !== undefined && row.deleted !== true)
  ) return false;
  return true;
}

function validTombstone(value: unknown): value is PersistedTombstone {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (
    !exactKeys(row, ['kind', 'id', 'tenantKey', 'expiresAt']) ||
    (row.kind !== 'call' && row.kind !== 'response') ||
    typeof row.id !== 'string' ||
    !isImageTenantHmac(row.tenantKey) ||
    !safeTimestamp(row.expiresAt)
  ) return false;
  return row.kind === 'call' ? CALL_ID_PATTERN.test(row.id) : RESPONSE_ID_PATTERN.test(row.id);
}

function validPendingReferenceDelete(value: unknown): value is PersistedPendingReferenceDelete {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return exactKeys(row, ['callId', 'referenceTenantKey', 'referenceId', 'expiresAt']) &&
    typeof row.callId === 'string' && CALL_ID_PATTERN.test(row.callId) &&
    isImageTenantHmac(row.referenceTenantKey) &&
    typeof row.referenceId === 'string' && REFERENCE_ID_PATTERN.test(row.referenceId) &&
    safeTimestamp(row.expiresAt);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sameBinding(left: PersistedCall, right: ResponsesImageCallBinding): boolean {
  return left.callId === right.callId &&
    left.referenceId === right.referenceId &&
    left.expiresAt === right.expiresAt;
}

function sameIds(left: readonly string[], right: readonly ResponsesImageCallId[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function bindingFrom(
  call: Pick<PersistedCall, 'callId' | 'referenceId' | 'expiresAt'>,
): ResponsesImageCallBinding {
  return Object.freeze({
    callId: call.callId as ResponsesImageCallId,
    referenceId: call.referenceId as ResponsesImageCallBinding['referenceId'],
    expiresAt: call.expiresAt,
  });
}

function tombstoneKey(value: Pick<PersistedTombstone, 'kind' | 'tenantKey' | 'id'>): string {
  return `${value.kind}\0${value.tenantKey}\0${value.id}`;
}

function pendingReferenceDeleteKey(
  value: Pick<PersistedPendingReferenceDelete, 'referenceTenantKey' | 'referenceId'>,
): string {
  return `${value.referenceTenantKey}\0${value.referenceId}`;
}

/** Durable production implementation of the existing Responses image-state contract. */
export class FileResponsesImageStateStore implements ResponsesImageStateStore {
  readonly #paths: DaemonImagePathResolver;
  #limits: FileResponsesImageStateStoreLimits;
  readonly #now: () => number;
  readonly #random: (bytes: number) => Buffer;
  readonly #replaceManifest: (targetPath: string, contents: Uint8Array) => void;
  readonly #tenantSalt: Buffer;
  #revision = 0;
  #calls = new Map<string, RuntimeCall>();
  #responses = new Map<string, RuntimeResponse>();
  #tombstones = new Map<string, PersistedTombstone>();
  #pendingReferenceDeletes = new Map<string, PersistedPendingReferenceDelete>();
  #tail: Promise<void> = Promise.resolve();

  constructor(options: FileResponsesImageStateStoreOptions) {
    validateLimits(options.limits);
    this.#paths = options.paths;
    this.#limits = options.limits;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? randomBytes;
    this.#replaceManifest = options.replaceManifest ?? ((target, contents) => this.atomicReplace(target, contents));
    this.#tenantSalt = loadOrCreateImageTenantHmacSalt(this.#paths, this.#random);
    this.loadManifest();
  }

  async commit(input: ResponsesImageStateCommitInput): Promise<readonly ResponsesImageCallBinding[]> {
    return this.commitWithLimits(input, this.#limits);
  }

  /** Generation-bound write entry point; reads and maintenance remain shared. */
  async commitWithLimits(
    input: ResponsesImageStateCommitInput,
    limits: FileResponsesImageStateStoreLimits,
  ): Promise<readonly ResponsesImageCallBinding[]> {
    validateLimits(limits);
    return this.exclusive(async () => {
      const now = this.#now();
      this.assertCommit(input, now, limits);
      const unique = new Set(input.bindings.map((binding) => binding.callId));
      if (unique.size !== input.bindings.length) throw this.failure();

      const tenantKey = this.tenantKey(input.tenantId);
      const referenceTenantKey = deriveImageTenantHmac(
        this.#tenantSalt,
        'reference',
        input.tenantId,
      );
      for (const binding of input.bindings) {
        const current = this.#calls.get(binding.callId);
        if (
          current &&
          (current.persisted.deleted ||
            current.persisted.tenantKey !== tenantKey ||
            !sameBinding(current.persisted, binding))
        ) throw this.failure();
      }

      const currentResponse = this.#responses.get(input.responseId);
      const callIds = Object.freeze(input.bindings.map((binding) => binding.callId));
      if (
        currentResponse &&
        (currentResponse.persisted.deleted ||
          currentResponse.persisted.tenantKey !== tenantKey ||
          currentResponse.persisted.expiresAt !== input.responseExpiresAt ||
          !sameIds(currentResponse.persisted.callIds, callIds))
      ) throw this.failure();

      const nextCalls = new Map(this.#calls);
      const nextResponses = new Map(this.#responses);
      const nextTombstones = this.prunedTombstones(now);
      const nextPendingReferenceDeletes = new Map(this.#pendingReferenceDeletes);
      const protectedCalls = new Set<string>(callIds);
      const additionalCalls = input.bindings.filter((binding) => !this.#calls.has(binding.callId)).length;
      const unleasedCalls = [...this.#calls.entries()].filter(
        ([id, entry]) => entry.activeLeases === 0 && !protectedCalls.has(id),
      );
      const evictableCalls = [
        ...unleasedCalls.filter(([, entry]) => entry.persisted.expiresAt <= now),
        ...unleasedCalls.filter(([, entry]) => entry.persisted.expiresAt > now),
      ];
      const callsToRemove = Math.max(0, this.#calls.size + additionalCalls - limits.maxCalls);
      if (evictableCalls.length < callsToRemove) throw this.failure();

      const additionalResponse = currentResponse ? 0 : 1;
      const unleasedResponses = [...this.#responses.entries()].filter(
        ([id, entry]) => entry.activeLeases === 0 && id !== input.responseId,
      );
      const evictableResponses = [
        ...unleasedResponses.filter(([, entry]) => entry.persisted.expiresAt <= now),
        ...unleasedResponses.filter(([, entry]) => entry.persisted.expiresAt > now),
      ];
      const responsesToRemove = Math.max(
        0,
        this.#responses.size + additionalResponse - limits.maxResponses,
      );
      if (evictableResponses.length < responsesToRemove) throw this.failure();

      const evicted: ResponsesImageCallBinding[] = [];
      for (const [id, entry] of evictableCalls.slice(0, callsToRemove)) {
        this.enqueuePendingReferenceDelete(nextPendingReferenceDeletes, entry.persisted, limits);
        nextCalls.delete(id);
        if (entry.persisted.expiresAt <= now) {
          this.rememberTombstone(nextTombstones, 'call', entry.persisted.tenantKey, id, now, limits);
        }
        evicted.push(bindingFrom(entry.persisted));
      }
      for (const [id, entry] of evictableResponses.slice(0, responsesToRemove)) {
        nextResponses.delete(id);
        if (entry.persisted.expiresAt <= now) {
          this.rememberTombstone(nextTombstones, 'response', entry.persisted.tenantKey, id, now, limits);
        }
      }

      for (const binding of input.bindings) {
        const current = nextCalls.get(binding.callId);
        if (current) {
          this.touch(nextCalls, binding.callId, current);
        } else {
          nextCalls.set(binding.callId, {
            activeLeases: 0,
            persisted: Object.freeze({
              callId: binding.callId,
              tenantKey,
              referenceTenantKey,
              referenceId: binding.referenceId,
              expiresAt: binding.expiresAt,
            }),
          });
        }
      }
      if (currentResponse) {
        this.touch(nextResponses, input.responseId, currentResponse);
      } else {
        nextResponses.set(input.responseId, {
          activeLeases: 0,
          persisted: Object.freeze({
            responseId: input.responseId,
            tenantKey,
            callIds,
            expiresAt: input.responseExpiresAt,
          }),
        });
      }

      this.persist(nextCalls, nextResponses, nextTombstones, nextPendingReferenceDeletes);
      this.#calls = nextCalls;
      this.#responses = nextResponses;
      this.#tombstones = nextTombstones;
      this.#pendingReferenceDeletes = nextPendingReferenceDeletes;
      return Object.freeze(evicted);
    });
  }

  /** Updates only app-session maintenance policy; pinned commits pass their own limits. */
  updateMaintenanceLimits(limits: FileResponsesImageStateStoreLimits): void {
    validateLimits(limits);
    this.#limits = { ...limits };
  }

  async resolveCall(
    tenantId: string,
    callId: ResponsesImageCallId,
  ): Promise<ResponsesImageCallResolution> {
    return this.exclusive(async () => {
      if (!safeTenant(tenantId) || !CALL_ID_PATTERN.test(callId)) return { status: 'not_found' };
      const now = this.#now();
      this.pruneTombstonesInPlace(now);
      const tenantKey = this.tenantKey(tenantId);
      const entry = this.#calls.get(callId);
      if (!entry || entry.persisted.tenantKey !== tenantKey || entry.persisted.deleted) {
        return this.hasTombstone('call', tenantKey, callId)
          ? { status: 'expired' }
          : { status: 'not_found' };
      }
      if (entry.persisted.expiresAt <= now) {
        this.rememberTombstone(this.#tombstones, 'call', tenantKey, callId, now);
        return { status: 'expired' };
      }
      entry.activeLeases += 1;
      this.touch(this.#calls, callId, entry);
      let released = false;
      return {
        status: 'found',
        lease: {
          binding: bindingFrom(entry.persisted),
          release: async () => {
            if (released) return;
            released = true;
            await this.releaseCall(callId);
          },
        },
      };
    });
  }

  async resolveResponse(
    tenantId: string,
    responseId: string,
  ): Promise<ResponsesImageResponseResolution> {
    return this.exclusive(async () => {
      if (!safeTenant(tenantId) || !RESPONSE_ID_PATTERN.test(responseId)) return { status: 'not_found' };
      const now = this.#now();
      this.pruneTombstonesInPlace(now);
      const tenantKey = this.tenantKey(tenantId);
      const entry = this.#responses.get(responseId);
      if (!entry || entry.persisted.tenantKey !== tenantKey || entry.persisted.deleted) {
        return this.hasTombstone('response', tenantKey, responseId)
          ? { status: 'expired' }
          : { status: 'not_found' };
      }
      if (entry.persisted.expiresAt <= now) {
        this.rememberTombstone(this.#tombstones, 'response', tenantKey, responseId, now);
        return { status: 'expired' };
      }
      entry.activeLeases += 1;
      this.touch(this.#responses, responseId, entry);
      let released = false;
      return {
        status: 'found',
        lease: {
          responseId,
          callIds: Object.freeze(entry.persisted.callIds.map((id) => id as ResponsesImageCallId)),
          expiresAt: entry.persisted.expiresAt,
          release: async () => {
            if (released) return;
            released = true;
            await this.releaseResponse(responseId);
          },
        },
      };
    });
  }

  async deleteCall(
    tenantId: string,
    callId: ResponsesImageCallId,
  ): Promise<ResponsesImageCallBinding | undefined> {
    return this.exclusive(async () => {
      if (!safeTenant(tenantId) || !CALL_ID_PATTERN.test(callId)) return undefined;
      const entry = this.#calls.get(callId);
      if (
        !entry ||
        entry.persisted.tenantKey !== this.tenantKey(tenantId) ||
        entry.persisted.deleted
      ) return undefined;
      const nextCalls = new Map(this.#calls);
      const nextPendingReferenceDeletes = new Map(this.#pendingReferenceDeletes);
      if (entry.activeLeases > 0) {
        nextCalls.set(callId, {
          activeLeases: entry.activeLeases,
          persisted: Object.freeze({ ...entry.persisted, deleted: true }),
        });
      } else {
        this.enqueuePendingReferenceDelete(nextPendingReferenceDeletes, entry.persisted);
        nextCalls.delete(callId);
      }
      this.persist(
        nextCalls,
        this.#responses,
        this.#tombstones,
        nextPendingReferenceDeletes,
      );
      this.#calls = nextCalls;
      this.#pendingReferenceDeletes = nextPendingReferenceDeletes;
      return bindingFrom(entry.persisted);
    });
  }

  async deleteResponse(tenantId: string, responseId: string): Promise<boolean> {
    return this.exclusive(async () => {
      if (!safeTenant(tenantId) || !RESPONSE_ID_PATTERN.test(responseId)) return false;
      const entry = this.#responses.get(responseId);
      if (
        !entry ||
        entry.persisted.tenantKey !== this.tenantKey(tenantId) ||
        entry.persisted.deleted
      ) return false;
      const nextResponses = new Map(this.#responses);
      if (entry.activeLeases > 0) {
        nextResponses.set(responseId, {
          activeLeases: entry.activeLeases,
          persisted: Object.freeze({ ...entry.persisted, deleted: true }),
        });
      } else {
        nextResponses.delete(responseId);
      }
      this.persist(
        this.#calls,
        nextResponses,
        this.#tombstones,
        this.#pendingReferenceDeletes,
      );
      this.#responses = nextResponses;
      return true;
    });
  }

  async cleanup(now = this.#now()): Promise<readonly ResponsesImageCallBinding[]> {
    return this.exclusive(async () => {
      if (!Number.isFinite(now)) throw new RangeError('cleanup time must be finite.');
      const nextCalls = new Map(this.#calls);
      const nextResponses = new Map(this.#responses);
      const nextTombstones = this.prunedTombstones(now);
      const nextPendingReferenceDeletes = new Map(this.#pendingReferenceDeletes);
      const removed: ResponsesImageCallBinding[] = [];
      for (const [callId, entry] of this.#calls) {
        const expired = entry.persisted.expiresAt <= now;
        if (expired) {
          this.rememberTombstone(
            nextTombstones,
            'call',
            entry.persisted.tenantKey,
            callId,
            now,
          );
        }
        if ((expired || entry.persisted.deleted) && entry.activeLeases === 0) {
          this.enqueuePendingReferenceDelete(nextPendingReferenceDeletes, entry.persisted);
          nextCalls.delete(callId);
          removed.push(bindingFrom(entry.persisted));
        }
      }
      for (const [responseId, entry] of this.#responses) {
        const expired = entry.persisted.expiresAt <= now;
        if (expired) {
          this.rememberTombstone(
            nextTombstones,
            'response',
            entry.persisted.tenantKey,
            responseId,
            now,
          );
        }
        if ((expired || entry.persisted.deleted) && entry.activeLeases === 0) {
          nextResponses.delete(responseId);
        }
      }

      const changed = nextCalls.size !== this.#calls.size ||
        nextResponses.size !== this.#responses.size ||
        !this.sameTombstones(nextTombstones, this.#tombstones) ||
        nextPendingReferenceDeletes.size !== this.#pendingReferenceDeletes.size;
      if (changed) {
        this.persist(
          nextCalls,
          nextResponses,
          nextTombstones,
          nextPendingReferenceDeletes,
        );
        this.#calls = nextCalls;
        this.#responses = nextResponses;
        this.#tombstones = nextTombstones;
        this.#pendingReferenceDeletes = nextPendingReferenceDeletes;
      }
      return Object.freeze(removed);
    });
  }

  pendingReferenceDeletes(
    limit = this.#limits.maxCalls,
  ): readonly PendingResponsesImageReferenceDelete[] {
    positiveInteger(limit, 'responses image pending-reference-delete limit');
    return Object.freeze(
      [...this.#pendingReferenceDeletes.values()].slice(0, limit).map((value) => Object.freeze({
        referenceTenantKey: value.referenceTenantKey,
        binding: bindingFrom(value),
      })),
    );
  }

  async acknowledgeReferenceDeletes(
    completed: readonly PendingResponsesImageReferenceDelete[],
  ): Promise<number> {
    return this.exclusive(async () => {
      if (!Array.isArray(completed)) {
        throw new TypeError('responses image reference-delete acknowledgements must be an array');
      }
      const next = new Map(this.#pendingReferenceDeletes);
      let removed = 0;
      for (const item of completed) {
        if (
          !item ||
          !isImageTenantHmac(item.referenceTenantKey) ||
          !item.binding ||
          !CALL_ID_PATTERN.test(item.binding.callId) ||
          !REFERENCE_ID_PATTERN.test(item.binding.referenceId) ||
          !safeTimestamp(item.binding.expiresAt)
        ) throw new TypeError('responses image reference-delete acknowledgement is invalid');
        const key = pendingReferenceDeleteKey({
          referenceTenantKey: item.referenceTenantKey,
          referenceId: item.binding.referenceId,
        });
        const current = next.get(key);
        if (
          current &&
          current.callId === item.binding.callId &&
          current.expiresAt === item.binding.expiresAt
        ) {
          next.delete(key);
          removed += 1;
        }
      }
      if (removed > 0) {
        this.persist(this.#calls, this.#responses, this.#tombstones, next);
        this.#pendingReferenceDeletes = next;
      }
      return removed;
    });
  }

  async reconcileBrokenReferenceLinks(
    hasLiveReference: (referenceTenantKey: string, referenceId: ResponsesImageCallBinding['referenceId']) =>
      Promise<boolean>,
    maxEntries: number,
  ): Promise<readonly ResponsesImageCallBinding[]> {
    positiveInteger(maxEntries, 'responses image broken-link reconciliation bound');
    return this.exclusive(async () => {
      const nextCalls = new Map(this.#calls);
      const nextPendingReferenceDeletes = new Map(this.#pendingReferenceDeletes);
      const removed: ResponsesImageCallBinding[] = [];
      for (const [callId, entry] of [...this.#calls].slice(0, maxEntries)) {
        if (entry.activeLeases > 0 || entry.persisted.deleted) continue;
        const exists = await hasLiveReference(
          entry.persisted.referenceTenantKey,
          entry.persisted.referenceId as ResponsesImageCallBinding['referenceId'],
        );
        if (exists) continue;
        this.enqueuePendingReferenceDelete(nextPendingReferenceDeletes, entry.persisted);
        nextCalls.delete(callId);
        removed.push(bindingFrom(entry.persisted));
      }
      if (removed.length > 0) {
        this.persist(
          nextCalls,
          this.#responses,
          this.#tombstones,
          nextPendingReferenceDeletes,
        );
        this.#calls = nextCalls;
        this.#pendingReferenceDeletes = nextPendingReferenceDeletes;
      }
      return Object.freeze(removed);
    });
  }

  status(): {
    readonly calls: number;
    readonly responses: number;
    readonly tombstones: number;
    readonly pendingReferenceDeletes: number;
  } {
    return Object.freeze({
      calls: this.#calls.size,
      responses: this.#responses.size,
      tombstones: this.#tombstones.size,
      pendingReferenceDeletes: this.#pendingReferenceDeletes.size,
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private failure(): ImageGenerationError {
    return new ImageGenerationError('image_generation_failed');
  }

  private assertCommit(
    input: ResponsesImageStateCommitInput,
    now: number,
    limits: FileResponsesImageStateStoreLimits,
  ): void {
    if (!safeTenant(input.tenantId) || !RESPONSE_ID_PATTERN.test(input.responseId)) throw this.failure();
    if (!Number.isSafeInteger(input.responseExpiresAt) || input.responseExpiresAt <= now) {
      throw this.failure();
    }
    if (!Array.isArray(input.bindings) || input.bindings.length > limits.maxCalls) {
      throw this.failure();
    }
    for (const binding of input.bindings) {
      if (
        !binding ||
        !CALL_ID_PATTERN.test(binding.callId) ||
        typeof binding.referenceId !== 'string' ||
        !REFERENCE_ID_PATTERN.test(binding.referenceId) ||
        !Number.isSafeInteger(binding.expiresAt) ||
        binding.expiresAt <= now
      ) throw this.failure();
    }
  }

  private tenantKey(tenantId: string): string {
    if (!safeTenant(tenantId)) throw this.failure();
    return deriveImageTenantHmac(this.#tenantSalt, 'responses-state', tenantId);
  }

  private rememberTombstone(
    tombstones: Map<string, PersistedTombstone>,
    kind: PersistedTombstone['kind'],
    tenantKey: string,
    id: string,
    now: number,
    limits = this.#limits,
  ): void {
    const value = Object.freeze({
      kind,
      tenantKey,
      id,
      expiresAt: now + limits.tombstoneTtlMs,
    });
    const key = tombstoneKey(value);
    tombstones.delete(key);
    tombstones.set(key, value);
    while (tombstones.size > limits.maxTombstones) {
      const oldest = tombstones.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      tombstones.delete(oldest);
    }
  }

  private enqueuePendingReferenceDelete(
    pending: Map<string, PersistedPendingReferenceDelete>,
    call: PersistedCall,
    limits = this.#limits,
  ): void {
    const key = pendingReferenceDeleteKey(call);
    if (pending.has(key)) return;
    if (pending.size >= limits.maxCalls) throw this.failure();
    pending.set(key, Object.freeze({
      callId: call.callId,
      referenceTenantKey: call.referenceTenantKey,
      referenceId: call.referenceId,
      expiresAt: call.expiresAt,
    }));
  }

  private hasTombstone(kind: PersistedTombstone['kind'], tenantKey: string, id: string): boolean {
    return this.#tombstones.has(tombstoneKey({ kind, tenantKey, id }));
  }

  private prunedTombstones(now: number): Map<string, PersistedTombstone> {
    return new Map([...this.#tombstones].filter(([, value]) => value.expiresAt > now));
  }

  private pruneTombstonesInPlace(now: number): void {
    for (const [key, value] of this.#tombstones) {
      if (value.expiresAt <= now) this.#tombstones.delete(key);
    }
  }

  private sameTombstones(
    left: ReadonlyMap<string, PersistedTombstone>,
    right: ReadonlyMap<string, PersistedTombstone>,
  ): boolean {
    if (left.size !== right.size) return false;
    return [...left].every(([key, value]) => {
      const other = right.get(key);
      return other?.expiresAt === value.expiresAt;
    });
  }

  private touch<K, V>(map: Map<K, V>, key: K, value: V): void {
    map.delete(key);
    map.set(key, value);
  }

  private async releaseCall(callId: string): Promise<void> {
    await this.exclusive(async () => {
      const entry = this.#calls.get(callId);
      if (entry && entry.activeLeases > 0) entry.activeLeases -= 1;
    });
  }

  private async releaseResponse(responseId: string): Promise<void> {
    await this.exclusive(async () => {
      const entry = this.#responses.get(responseId);
      if (entry && entry.activeLeases > 0) entry.activeLeases -= 1;
    });
  }

  private manifestPath(): string {
    return join(this.#paths.verifiedRoot('state'), MANIFEST_NAME);
  }

  private persist(
    calls: ReadonlyMap<string, RuntimeCall>,
    responses: ReadonlyMap<string, RuntimeResponse>,
    tombstones: ReadonlyMap<string, PersistedTombstone>,
    pendingReferenceDeletes: ReadonlyMap<string, PersistedPendingReferenceDelete>,
  ): void {
    const manifest: PersistedManifest = {
      version: MANIFEST_VERSION,
      revision: this.#revision + 1,
      calls: [...calls.values()].map((entry) => entry.persisted),
      responses: [...responses.values()].map((entry) => entry.persisted),
      tombstones: [...tombstones.values()],
      pendingReferenceDeletes: [...pendingReferenceDeletes.values()],
    };
    const serialized = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    if (serialized.byteLength > MAX_MANIFEST_BYTES) {
      throw new Error('responses image state manifest exceeds its bound');
    }
    this.#replaceManifest(this.manifestPath(), serialized);
    this.#revision = manifest.revision;
  }

  private atomicReplace(targetPath: string, contents: Uint8Array): void {
    const root = this.#paths.verifiedRoot('state');
    if (!samePath(dirname(resolve(targetPath)), root) || basename(targetPath) !== MANIFEST_NAME) {
      throw new TypeError('invalid responses image state manifest target');
    }
    const temporaryPath = join(
      root,
      `.responses-image-state.${process.pid}.${this.#random(8).toString('hex')}.tmp`,
    );
    let fd: number | undefined;
    try {
      fd = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(fd, contents);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporaryPath, targetPath);
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* preserve the original failure */ }
      }
      if (existsSync(temporaryPath)) {
        try { unlinkSync(temporaryPath); } catch { /* preserve the original failure */ }
      }
    }
  }

  private loadManifest(): void {
    const path = this.manifestPath();
    if (!existsSync(path)) return;
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_MANIFEST_BYTES) {
      throw new TypeError('responses image state manifest is invalid');
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('responses image state manifest is invalid');
    }
    const manifest = parsed as Record<string, unknown>;
    if (
      !exactKeys(
        manifest,
        ['version', 'revision', 'calls', 'responses', 'tombstones', 'pendingReferenceDeletes'],
      ) ||
      manifest.version !== MANIFEST_VERSION ||
      typeof manifest.revision !== 'number' ||
      !Number.isSafeInteger(manifest.revision) || manifest.revision < 0 ||
      !Array.isArray(manifest.calls) ||
      !Array.isArray(manifest.responses) ||
      !Array.isArray(manifest.tombstones) ||
      !Array.isArray(manifest.pendingReferenceDeletes)
    ) throw new TypeError('responses image state manifest is invalid');

    let repaired = manifest.calls.length > this.#limits.maxCalls ||
      manifest.responses.length > this.#limits.maxResponses ||
      manifest.tombstones.length > this.#limits.maxTombstones ||
      manifest.pendingReferenceDeletes.length > this.#limits.maxCalls;
    const calls = new Map<string, RuntimeCall>();
    for (const value of manifest.calls.slice(0, this.#limits.maxCalls)) {
      if (!validCall(value) || calls.has(value.callId)) {
        repaired = true;
        continue;
      }
      calls.set(value.callId, {
        activeLeases: 0,
        persisted: Object.freeze({ ...value }),
      });
    }
    const responses = new Map<string, RuntimeResponse>();
    for (const value of manifest.responses.slice(0, this.#limits.maxResponses)) {
      if (
        !validResponse(value) ||
        value.callIds.length > this.#limits.maxCalls ||
        responses.has(value.responseId) ||
        value.callIds.some((callId) => {
          const call = calls.get(callId);
          return call !== undefined && call.persisted.tenantKey !== value.tenantKey;
        })
      ) {
        repaired = true;
        continue;
      }
      responses.set(value.responseId, {
        activeLeases: 0,
        persisted: Object.freeze({ ...value, callIds: Object.freeze([...value.callIds]) }),
      });
    }
    const tombstones = new Map<string, PersistedTombstone>();
    for (const value of manifest.tombstones.slice(0, this.#limits.maxTombstones)) {
      if (!validTombstone(value)) {
        repaired = true;
        continue;
      }
      const key = tombstoneKey(value);
      if (tombstones.has(key)) {
        repaired = true;
        continue;
      }
      tombstones.set(key, Object.freeze({ ...value }));
    }
    const pendingReferenceDeletes = new Map<string, PersistedPendingReferenceDelete>();
    for (const value of manifest.pendingReferenceDeletes.slice(0, this.#limits.maxCalls)) {
      if (!validPendingReferenceDelete(value)) {
        repaired = true;
        continue;
      }
      const key = pendingReferenceDeleteKey(value);
      if (pendingReferenceDeletes.has(key)) {
        repaired = true;
        continue;
      }
      pendingReferenceDeletes.set(key, Object.freeze({ ...value }));
    }
    this.#revision = manifest.revision;
    this.#calls = calls;
    this.#responses = responses;
    this.#tombstones = tombstones;
    this.#pendingReferenceDeletes = pendingReferenceDeletes;
    if (repaired) this.persist(calls, responses, tombstones, pendingReferenceDeletes);
  }
}
