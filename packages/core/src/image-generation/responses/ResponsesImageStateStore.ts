import { ImageGenerationError } from '../errors';
import type { ResponsesImageCallBinding, ResponsesImageCallId } from './types';

export interface ResponsesImageCallStateLease {
  readonly binding: ResponsesImageCallBinding;
  release(): Promise<void>;
}

export interface ResponsesImageResponseStateLease {
  readonly responseId: string;
  readonly callIds: readonly ResponsesImageCallId[];
  readonly expiresAt: number;
  release(): Promise<void>;
}

export type ResponsesImageCallResolution =
  | { readonly status: 'found'; readonly lease: ResponsesImageCallStateLease }
  | { readonly status: 'expired' }
  | { readonly status: 'not_found' };

export type ResponsesImageResponseResolution =
  | { readonly status: 'found'; readonly lease: ResponsesImageResponseStateLease }
  | { readonly status: 'expired' }
  | { readonly status: 'not_found' };

export interface ResponsesImageStateCommitInput {
  readonly tenantId: string;
  readonly responseId: string;
  /** Empty is an explicit known-empty response marker, never a no-op. */
  readonly bindings: readonly ResponsesImageCallBinding[];
  readonly responseExpiresAt: number;
}

export interface ResponsesImageStateStore {
  commit(input: ResponsesImageStateCommitInput): Promise<readonly ResponsesImageCallBinding[]>;
  resolveCall(tenantId: string, callId: ResponsesImageCallId): Promise<ResponsesImageCallResolution>;
  resolveResponse(tenantId: string, responseId: string): Promise<ResponsesImageResponseResolution>;
  deleteCall(tenantId: string, callId: ResponsesImageCallId): Promise<ResponsesImageCallBinding | undefined>;
  deleteResponse(tenantId: string, responseId: string): Promise<boolean>;
  cleanup(now?: number): Promise<readonly ResponsesImageCallBinding[]>;
}

export interface InMemoryResponsesImageStateStoreOptions {
  readonly maxCalls?: number;
  readonly maxResponses?: number;
  readonly maxTombstones?: number;
  readonly tombstoneTtlMs?: number;
  readonly now?: () => number;
}

interface CallEntry {
  readonly tenantId: string;
  readonly binding: ResponsesImageCallBinding;
  activeLeases: number;
  deleted: boolean;
}

interface ResponseEntry {
  readonly tenantId: string;
  readonly responseId: string;
  readonly callIds: readonly ResponsesImageCallId[];
  readonly expiresAt: number;
  activeLeases: number;
  deleted: boolean;
}

const CALL_ID_PATTERN = /^ig_[A-Za-z0-9_-]{16,128}$/;
const RESPONSE_ID_PATTERN = /^resp_[A-Za-z0-9_-]{1,240}$/;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive.`);
  return value;
}

function safeTenant(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
}

function sameBinding(a: ResponsesImageCallBinding, b: ResponsesImageCallBinding): boolean {
  return a.callId === b.callId && a.referenceId === b.referenceId && a.expiresAt === b.expiresAt;
}

function sameIds(a: readonly ResponsesImageCallId[], b: readonly ResponsesImageCallId[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Bounded deterministic test/default implementation; production wiring may inject persistence. */
export class InMemoryResponsesImageStateStore implements ResponsesImageStateStore {
  readonly #calls = new Map<ResponsesImageCallId, CallEntry>();
  readonly #responses = new Map<string, ResponseEntry>();
  readonly #tombstones = new Map<string, number>();
  readonly #maxCalls: number;
  readonly #maxResponses: number;
  readonly #maxTombstones: number;
  readonly #tombstoneTtlMs: number;
  readonly #now: () => number;

  constructor(options: InMemoryResponsesImageStateStoreOptions = {}) {
    this.#maxCalls = positiveInteger(options.maxCalls ?? 10_000, 'maxCalls');
    this.#maxResponses = positiveInteger(options.maxResponses ?? 10_000, 'maxResponses');
    this.#maxTombstones = positiveInteger(options.maxTombstones ?? 2_000, 'maxTombstones');
    this.#tombstoneTtlMs = positiveInteger(
      options.tombstoneTtlMs ?? 60 * 60_000,
      'tombstoneTtlMs',
    );
    this.#now = options.now ?? Date.now;
  }

  async commit(input: ResponsesImageStateCommitInput): Promise<readonly ResponsesImageCallBinding[]> {
    const now = this.#now();
    this.#pruneTombstones(now);
    this.#assertCommit(input, now);
    const unique = new Set(input.bindings.map((binding) => binding.callId));
    if (unique.size !== input.bindings.length) {
      throw new ImageGenerationError('image_generation_failed');
    }

    for (const binding of input.bindings) {
      const current = this.#calls.get(binding.callId);
      if (
        current &&
        (current.deleted || current.tenantId !== input.tenantId || !sameBinding(current.binding, binding))
      ) {
        throw new ImageGenerationError('image_generation_failed');
      }
    }
    const currentResponse = this.#responses.get(input.responseId);
    const callIds = Object.freeze(input.bindings.map((binding) => binding.callId));
    if (
      currentResponse &&
      (currentResponse.deleted ||
        currentResponse.tenantId !== input.tenantId ||
        currentResponse.expiresAt !== input.responseExpiresAt ||
        !sameIds(currentResponse.callIds, callIds))
    ) {
      throw new ImageGenerationError('image_generation_failed');
    }

    const protectedCalls = new Set(callIds);
    const additionalCalls = input.bindings.filter((binding) => !this.#calls.has(binding.callId)).length;
    const unleasedCalls = [...this.#calls.entries()].filter(
      ([id, entry]) => entry.activeLeases === 0 && !protectedCalls.has(id),
    );
    const evictableCalls = [
      ...unleasedCalls.filter(([, entry]) => entry.binding.expiresAt <= now),
      ...unleasedCalls.filter(([, entry]) => entry.binding.expiresAt > now),
    ];
    const callsToRemove = Math.max(0, this.#calls.size + additionalCalls - this.#maxCalls);
    if (evictableCalls.length < callsToRemove) {
      throw new ImageGenerationError('image_generation_failed');
    }
    const additionalResponse = currentResponse ? 0 : 1;
    const unleasedResponses = [...this.#responses.entries()].filter(
      ([id, entry]) => entry.activeLeases === 0 && id !== input.responseId,
    );
    const evictableResponses = [
      ...unleasedResponses.filter(([, entry]) => entry.expiresAt <= now),
      ...unleasedResponses.filter(([, entry]) => entry.expiresAt > now),
    ];
    const responsesToRemove = Math.max(
      0,
      this.#responses.size + additionalResponse - this.#maxResponses,
    );
    if (evictableResponses.length < responsesToRemove) {
      throw new ImageGenerationError('image_generation_failed');
    }

    const evicted: ResponsesImageCallBinding[] = [];
    for (const [id, entry] of evictableCalls.slice(0, callsToRemove)) {
      if (entry.binding.expiresAt <= now) {
        this.#rememberTombstone('call', entry.tenantId, id, now);
      }
      this.#calls.delete(id);
      evicted.push(entry.binding);
    }
    for (const [id, entry] of evictableResponses.slice(0, responsesToRemove)) {
      if (entry.expiresAt <= now) {
        this.#rememberTombstone('response', entry.tenantId, id, now);
      }
      this.#responses.delete(id);
    }

    for (const binding of input.bindings) {
      const current = this.#calls.get(binding.callId);
      if (current) {
        this.#touch(this.#calls, binding.callId, current);
      } else {
        this.#calls.set(binding.callId, {
          tenantId: input.tenantId,
          binding: Object.freeze({ ...binding }),
          activeLeases: 0,
          deleted: false,
        });
      }
    }
    if (currentResponse) {
      this.#touch(this.#responses, input.responseId, currentResponse);
    } else {
      this.#responses.set(input.responseId, {
        tenantId: input.tenantId,
        responseId: input.responseId,
        callIds,
        expiresAt: input.responseExpiresAt,
        activeLeases: 0,
        deleted: false,
      });
    }
    return Object.freeze(evicted);
  }

  async resolveCall(
    tenantId: string,
    callId: ResponsesImageCallId,
  ): Promise<ResponsesImageCallResolution> {
    if (!safeTenant(tenantId) || !CALL_ID_PATTERN.test(callId)) return { status: 'not_found' };
    const now = this.#now();
    this.#pruneTombstones(now);
    const entry = this.#calls.get(callId);
    if (!entry || entry.tenantId !== tenantId || entry.deleted) {
      return this.#hasTombstone('call', tenantId, callId) ? { status: 'expired' } : { status: 'not_found' };
    }
    if (entry.binding.expiresAt <= now) {
      this.#rememberTombstone('call', tenantId, callId, now);
      return { status: 'expired' };
    }
    entry.activeLeases += 1;
    this.#touch(this.#calls, callId, entry);
    let released = false;
    return {
      status: 'found',
      lease: {
        binding: entry.binding,
        async release() {
          if (released) return;
          released = true;
          entry.activeLeases = Math.max(0, entry.activeLeases - 1);
        },
      },
    };
  }

  async resolveResponse(
    tenantId: string,
    responseId: string,
  ): Promise<ResponsesImageResponseResolution> {
    if (!safeTenant(tenantId) || !RESPONSE_ID_PATTERN.test(responseId)) return { status: 'not_found' };
    const now = this.#now();
    this.#pruneTombstones(now);
    const entry = this.#responses.get(responseId);
    if (!entry || entry.tenantId !== tenantId || entry.deleted) {
      return this.#hasTombstone('response', tenantId, responseId)
        ? { status: 'expired' }
        : { status: 'not_found' };
    }
    if (entry.expiresAt <= now) {
      this.#rememberTombstone('response', tenantId, responseId, now);
      return { status: 'expired' };
    }
    entry.activeLeases += 1;
    this.#touch(this.#responses, responseId, entry);
    let released = false;
    return {
      status: 'found',
      lease: {
        responseId,
        callIds: entry.callIds,
        expiresAt: entry.expiresAt,
        async release() {
          if (released) return;
          released = true;
          entry.activeLeases = Math.max(0, entry.activeLeases - 1);
        },
      },
    };
  }

  async deleteCall(
    tenantId: string,
    callId: ResponsesImageCallId,
  ): Promise<ResponsesImageCallBinding | undefined> {
    const entry = this.#calls.get(callId);
    if (!entry || entry.tenantId !== tenantId || entry.deleted) return undefined;
    entry.deleted = true;
    if (entry.activeLeases === 0) this.#calls.delete(callId);
    return entry.binding;
  }

  async deleteResponse(tenantId: string, responseId: string): Promise<boolean> {
    const entry = this.#responses.get(responseId);
    if (!entry || entry.tenantId !== tenantId || entry.deleted) return false;
    entry.deleted = true;
    if (entry.activeLeases === 0) this.#responses.delete(responseId);
    return true;
  }

  async cleanup(now = this.#now()): Promise<readonly ResponsesImageCallBinding[]> {
    if (!Number.isFinite(now)) throw new RangeError('cleanup time must be finite.');
    this.#pruneTombstones(now);
    const removed: ResponsesImageCallBinding[] = [];
    for (const [callId, entry] of this.#calls) {
      const expired = entry.binding.expiresAt <= now;
      if (expired) this.#rememberTombstone('call', entry.tenantId, callId, now);
      if ((expired || entry.deleted) && entry.activeLeases === 0) {
        this.#calls.delete(callId);
        removed.push(entry.binding);
      }
    }
    for (const [responseId, entry] of this.#responses) {
      const expired = entry.expiresAt <= now;
      if (expired) this.#rememberTombstone('response', entry.tenantId, responseId, now);
      if ((expired || entry.deleted) && entry.activeLeases === 0) {
        this.#responses.delete(responseId);
      }
    }
    return Object.freeze(removed);
  }

  #assertCommit(input: ResponsesImageStateCommitInput, now: number): void {
    if (!safeTenant(input.tenantId)) throw new ImageGenerationError('image_generation_failed');
    if (!RESPONSE_ID_PATTERN.test(input.responseId)) {
      throw new ImageGenerationError('image_generation_failed');
    }
    if (!Number.isSafeInteger(input.responseExpiresAt) || input.responseExpiresAt <= now) {
      throw new ImageGenerationError('image_generation_failed');
    }
    if (!Array.isArray(input.bindings)) throw new ImageGenerationError('image_generation_failed');
    for (const binding of input.bindings) {
      if (
        !binding ||
        !CALL_ID_PATTERN.test(binding.callId) ||
        typeof binding.referenceId !== 'string' ||
        binding.referenceId.length === 0 ||
        !Number.isSafeInteger(binding.expiresAt) ||
        binding.expiresAt <= now
      ) {
        throw new ImageGenerationError('image_generation_failed');
      }
    }
  }

  #rememberTombstone(kind: 'call' | 'response', tenantId: string, id: string, now: number): void {
    const key = `${kind}\u0000${tenantId}\u0000${id}`;
    this.#tombstones.delete(key);
    this.#tombstones.set(key, now + this.#tombstoneTtlMs);
    while (this.#tombstones.size > this.#maxTombstones) {
      const oldest = this.#tombstones.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#tombstones.delete(oldest);
    }
  }

  #hasTombstone(kind: 'call' | 'response', tenantId: string, id: string): boolean {
    return this.#tombstones.has(`${kind}\u0000${tenantId}\u0000${id}`);
  }

  #pruneTombstones(now: number): void {
    for (const [key, expiresAt] of this.#tombstones) {
      if (expiresAt <= now) this.#tombstones.delete(key);
    }
  }

  #touch<K, V>(map: Map<K, V>, key: K, value: V): void {
    map.delete(key);
    map.set(key, value);
  }
}
