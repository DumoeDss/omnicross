/**
 * ServerOverloadCounter — a bounded, metadata-only tally of Codex server-
 * overload events (`response.failed` with `error.code` `server_is_overloaded` /
 * `slow_down`) per provider+account+endpoint.
 *
 * WHY a dedicated store (not derived from {@link AccountRouteActivity}): those
 * 200-status overloads are invisible at the route-activity HTTP-status layer, and
 * the route-activity ring (300 rows) can be pushed out by normal traffic before
 * an operator notices. This counter ACCUMULATES across the ring and keeps a
 * bounded recent-timestamp ring for a trend sparkline, so "how often is account X
 * being overloaded, and is it worsening" stays answerable.
 *
 * Overload is account-INDEPENDENT server capacity (retrying on another account is
 * pointless), so — unlike {@link SubscriptionAccountHealth} — this store only
 * OBSERVES; it never gates scheduling. It carries no secrets, only counts + epoch
 * timestamps. In-memory (cleared on restart), same as the other pipeline stores.
 *
 * Shaped like `SubscriptionAccountHealth`: an in-memory `Map`, an injectable
 * `now` clock, no external deps, opaque `providerId\0accountId\0endpoint` keys.
 *
 * @module pipeline/ServerOverloadCounter
 */

import type { AccountRouteEndpoint } from './AccountRouteActivity';

/** Bounded recent-event ring per entry — the sparkline's data source. */
export const OVERLOAD_RECENT_LIMIT = 64;
/**
 * Entries with no event in this window are pruned on read, so the map cannot
 * grow unbounded across a long-lived process with many transient accounts.
 */
export const OVERLOAD_ENTRY_TTL_MS = 24 * 60 * 60_000;

export interface OverloadRecordInput {
  providerId: string;
  accountId: string;
  endpoint: AccountRouteEndpoint;
  /** Epoch-ms of the event. Omit to use the clock default. */
  now?: number;
}

export interface OverloadCounterEntry {
  providerId: string;
  accountId: string;
  endpoint: AccountRouteEndpoint;
  /** Lifetime count of overload events for this key (since first observed). */
  count: number;
  firstTs: number;
  lastTs: number;
  /** Most-recent-first epoch-ms events, capped at {@link OVERLOAD_RECENT_LIMIT}. */
  recent: number[];
}

export interface OverloadCounterQuery {
  providerId?: string;
  accountId?: string;
}

function entryKey(providerId: string, accountId: string, endpoint: AccountRouteEndpoint): string {
  return `${providerId}\0${accountId}\0${endpoint}`;
}

export class ServerOverloadCounterStore {
  private readonly entries = new Map<string, OverloadCounterEntry>();

  /**
   * Record one overload event. Creates the entry on first sight, then bumps
   * `count`, `lastTs`, and prepends the event to the bounded `recent` ring.
   */
  recordOverload(input: OverloadRecordInput, now: number = Date.now()): OverloadCounterEntry {
    const key = entryKey(input.providerId, input.accountId, input.endpoint);
    const existing = this.entries.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastTs = now;
      existing.recent.unshift(now);
      if (existing.recent.length > OVERLOAD_RECENT_LIMIT) {
        existing.recent.length = OVERLOAD_RECENT_LIMIT;
      }
      return { ...existing, recent: [...existing.recent] };
    }
    const entry: OverloadCounterEntry = {
      providerId: input.providerId,
      accountId: input.accountId,
      endpoint: input.endpoint,
      count: 1,
      firstTs: now,
      lastTs: now,
      recent: [now],
    };
    this.entries.set(key, entry);
    return { ...entry, recent: [...entry.recent] };
  }

  /**
   * Snapshot all (optionally filtered) entries, pruning stale ones first. Returns
   * copies — callers (admin API → JSON) never see the live mutable entries.
   */
  list(query: OverloadCounterQuery = {}, now: number = Date.now()): OverloadCounterEntry[] {
    const providerId = query.providerId?.trim();
    const accountId = query.accountId?.trim();
    const out: OverloadCounterEntry[] = [];
    for (const [key, entry] of this.entries) {
      if (now - entry.lastTs > OVERLOAD_ENTRY_TTL_MS) {
        this.entries.delete(key);
        continue;
      }
      if (providerId && entry.providerId !== providerId) continue;
      if (accountId && entry.accountId !== accountId) continue;
      out.push({ ...entry, recent: [...entry.recent] });
    }
    return out;
  }

  clear(): void {
    this.entries.clear();
  }
}

let sharedStore: ServerOverloadCounterStore | null = null;

export function getSharedOverloadCounter(): ServerOverloadCounterStore {
  if (!sharedStore) sharedStore = new ServerOverloadCounterStore();
  return sharedStore;
}

/**
 * TEST SEAM — swap the singleton (e.g. with a fresh instance). Mirrors the
 * `setShared…`/`__reset…ForTests` discipline of the sibling pipeline stores.
 */
export function setSharedOverloadCounter(instance: ServerOverloadCounterStore): void {
  sharedStore = instance;
}

export function __resetSharedOverloadCounterForTests(): void {
  sharedStore = null;
}
