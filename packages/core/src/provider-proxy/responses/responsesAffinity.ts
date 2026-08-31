import { OpenAIOperationError } from '../../openai-operation';

export type ResponsesCredentialIdentity =
  | { readonly kind: 'subscription-account'; readonly id: string }
  | { readonly kind: 'byo-key'; readonly id: string }
  | { readonly kind: 'provider-key'; readonly id: string };

export interface ResponsesAffinityScope {
  readonly providerId: string;
  readonly clientScope: string;
  readonly sessionKey: string;
}

export interface ResponsesAffinityPendingImageReceipt {
  readonly upstreamCallId: string;
  readonly publicImageCallId: string;
}

export interface ResponsesAffinityHostedImageState {
  readonly hasImageContext: boolean;
  readonly pendingReceipts: readonly ResponsesAffinityPendingImageReceipt[];
}

export interface ResponsesAffinityRecord extends ResponsesAffinityScope {
  readonly responseId: string;
  readonly credential: ResponsesCredentialIdentity;
  readonly hostedImage?: ResponsesAffinityHostedImageState;
}

export interface ResponsesAffinityEntry extends ResponsesAffinityRecord {
  readonly expiresAt: number;
}

export interface ResponsesAffinityStoreOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export function previousResponseNotFound(): OpenAIOperationError {
  return new OpenAIOperationError({
    status: 404,
    code: 'previous_response_not_found',
    message: 'Previous response is unavailable; retry with the complete history and no previous response reference',
  });
}

const MAX_PENDING_IMAGE_RECEIPTS = 16;
const UPSTREAM_CALL_ID_PATTERN = /^call_[A-Za-z0-9_-]{1,240}$/;
const PUBLIC_IMAGE_CALL_ID_PATTERN = /^ig_[A-Za-z0-9_-]{16,128}$/;
const INVALID_HOSTED_IMAGE_METADATA = 'Invalid hosted image affinity metadata';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

/** Copy and freeze the only hosted-image continuation data allowed into affinity. */
function normalizeHostedImageState(value: unknown): ResponsesAffinityHostedImageState {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['hasImageContext', 'pendingReceipts']) ||
      typeof value.hasImageContext !== 'boolean' ||
      !Array.isArray(value.pendingReceipts) ||
      value.pendingReceipts.length > MAX_PENDING_IMAGE_RECEIPTS
    ) {
      throw new TypeError(INVALID_HOSTED_IMAGE_METADATA);
    }

    const upstreamCallIds = new Set<string>();
    const publicImageCallIds = new Set<string>();
    const pendingReceipts = value.pendingReceipts.map((candidate) => {
      if (
        !isRecord(candidate) ||
        !hasExactKeys(candidate, ['upstreamCallId', 'publicImageCallId']) ||
        typeof candidate.upstreamCallId !== 'string' ||
        !UPSTREAM_CALL_ID_PATTERN.test(candidate.upstreamCallId) ||
        typeof candidate.publicImageCallId !== 'string' ||
        !PUBLIC_IMAGE_CALL_ID_PATTERN.test(candidate.publicImageCallId) ||
        upstreamCallIds.has(candidate.upstreamCallId) ||
        publicImageCallIds.has(candidate.publicImageCallId)
      ) {
        throw new TypeError(INVALID_HOSTED_IMAGE_METADATA);
      }
      upstreamCallIds.add(candidate.upstreamCallId);
      publicImageCallIds.add(candidate.publicImageCallId);
      return Object.freeze({
        upstreamCallId: candidate.upstreamCallId,
        publicImageCallId: candidate.publicImageCallId,
      });
    });

    return Object.freeze({
      hasImageContext: value.hasImageContext,
      pendingReceipts: Object.freeze(pendingReceipts),
    });
  } catch {
    // Never reflect malformed receipt values, prompts, ids, or other caller data.
    throw new TypeError(INVALID_HOSTED_IMAGE_METADATA);
  }
}

/** Bounded process-local response identity index with sliding expiry and LRU eviction. */
export class ResponsesAffinityStore {
  private readonly entries = new Map<string, ResponsesAffinityEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: ResponsesAffinityStoreOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 10_000));
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? 6 * 60 * 60_000));
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  record(record: ResponsesAffinityRecord): void {
    if (!record.responseId.trim() || !record.credential.id.trim()) return;
    const hostedImage = record.hostedImage === undefined
      ? undefined
      : normalizeHostedImageState(record.hostedImage);
    this.pruneExpired();
    const entry: ResponsesAffinityEntry = Object.freeze({
      providerId: record.providerId,
      clientScope: record.clientScope,
      sessionKey: record.sessionKey,
      responseId: record.responseId,
      credential: Object.freeze({ ...record.credential }),
      ...(hostedImage ? { hostedImage } : {}),
      expiresAt: this.now() + this.ttlMs,
    });
    this.entries.delete(record.responseId);
    this.entries.set(record.responseId, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Lookup never discloses whether an id exists in another provider/client/session scope. */
  lookup(responseId: string, scope: ResponsesAffinityScope): ResponsesAffinityEntry {
    const entry = this.entries.get(responseId);
    const now = this.now();
    if (
      !entry ||
      entry.expiresAt <= now ||
      entry.providerId !== scope.providerId ||
      entry.clientScope !== scope.clientScope ||
      entry.sessionKey !== scope.sessionKey
    ) {
      if (entry?.expiresAt !== undefined && entry.expiresAt <= now) {
        this.entries.delete(responseId);
      }
      throw previousResponseNotFound();
    }
    const refreshed = Object.freeze({ ...entry, expiresAt: now + this.ttlMs });
    this.entries.delete(responseId);
    this.entries.set(responseId, refreshed);
    return refreshed;
  }

  clear(): void {
    this.entries.clear();
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [responseId, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(responseId);
    }
  }
}

const defaultStores = new WeakMap<object, ResponsesAffinityStore>();

/** Resolve one affinity store per app-session dependency container. */
export function getResponsesAffinityStore(owner: object): ResponsesAffinityStore {
  let store = defaultStores.get(owner);
  if (!store) {
    store = new ResponsesAffinityStore();
    defaultStores.set(owner, store);
  }
  return store;
}
