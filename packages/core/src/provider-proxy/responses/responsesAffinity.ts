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

export interface ResponsesAffinityRecord extends ResponsesAffinityScope {
  readonly responseId: string;
  readonly credential: ResponsesCredentialIdentity;
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
    this.pruneExpired();
    const entry: ResponsesAffinityEntry = {
      ...record,
      expiresAt: this.now() + this.ttlMs,
    };
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
    const refreshed = { ...entry, expiresAt: now + this.ttlMs };
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
