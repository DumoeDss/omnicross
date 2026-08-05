/**
 * SubscriptionAccountSelector — the pure, in-memory account scheduler
 * (subscription-account-scheduling, design D3).
 *
 * Given a provider's account list (+ an optional session key) it decides WHICH
 * account of the pool serves the outbound request:
 *
 *   filter `schedulable !== false`
 *     → session-affinity short-circuit (sticky `sessionKey → accountId`, TTL 1h)
 *     → sort by `priority` asc → effective `lastUsedAt` asc (LRU) → `createdAt` asc
 *     → `[0]`.
 *
 * The class holds process-lived state: a session-affinity map and an in-memory
 * `lastUsedAt` overlay. The overlay is seeded from persisted state and advanced
 * to `now` on each selection, so repeated selections rotate fairly even before
 * durable persistence. One instance is constructed at bootstrap and shared by
 * all three auth strategies, with every call scoped by `providerId`.
 *
 * ZERO-REGRESSION CARRIER: `select()` returns `null` when the schedulable account
 * count is ≤ 1. Callers treat `null` (and an `isActive` result) as "use the
 * existing active-mirror path", so a single-account provider exercises NO new
 * code and its token read is byte-identical to before this change.
 *
 * @module scheduler/SubscriptionAccountSelector
 */

import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';

/** Sticky session→account affinity TTL (1 hour). */
export const SESSION_AFFINITY_TTL_MS = 3_600_000;
/** Min gap between best-effort `lastUsedAt` durable persists, per account. */
export const LAST_USED_PERSIST_THROTTLE_MS = 60_000;
/** Precedence assumed for an account with no explicit `priority`. */
export const DEFAULT_ACCOUNT_PRIORITY = 50;

/** One schedulable candidate — the scheduling projection of an account entry. */
export interface SchedulableAccount {
  id: string;
  /** Operator-defined pool group used by resource-level gateway bindings. */
  group?: string;
  /** Default `50` (lower = higher precedence). */
  priority?: number;
  /** ISO — LRU tie-break; absent ⇒ treated as least-recently-used (`0`). */
  lastUsedAt?: string;
  /** ISO — final tie-break; absent ⇒ oldest (`0`). */
  createdAt?: string;
  /** Default `true`; child #2 (account health) sets `false` for an unhealthy
   *  account and the selector skips it. */
  schedulable?: boolean;
}

export interface SelectInput {
  providerId: SubscriptionProviderId;
  accounts: readonly SchedulableAccount[];
  /** The persistent active-account pointer (for the `isActive` discriminant). */
  activeAccountId?: string;
  /** Stable per-conversation key for session affinity; absent ⇒ pure priority/LRU. */
  sessionKey?: string;
  /** Injectable clock for tests (default `Date.now()`). */
  now?: number;
}

export interface SelectResult {
  accountId: string;
  /** `true` when the chosen account is the active one — the caller then runs the
   *  existing active-mirror getter verbatim (no by-id read). */
  isActive: boolean;
}

interface AffinityEntry {
  accountId: string;
  expiresAt: number;
}

function scopedKey(providerId: SubscriptionProviderId, tail: string): string {
  return `${providerId}\0${tail}`;
}

function parseIso(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

export class SubscriptionAccountSelector {
  /** `providerId\0accountId → live lastUsedAt ms` (authoritative tie-break). */
  private readonly lastUsedOverlay = new Map<string, number>();
  /** `providerId\0sessionKey → { accountId, expiresAt }`. */
  private readonly affinity = new Map<string, AffinityEntry>();
  /** `providerId\0accountId → last durable-persist ms` (throttle state). */
  private readonly lastPersist = new Map<string, number>();

  /**
   * Choose the account to serve this request, or `null` when there are ≤ 1
   * schedulable accounts (the zero-regression signal — caller uses the active
   * account). Updates the live `lastUsedAt` overlay for the chosen account and,
   * when a `sessionKey` is given, records/extends the affinity mapping.
   */
  select(input: SelectInput): SelectResult | null {
    const now = input.now ?? Date.now();
    const schedulable = input.accounts.filter((a) => a.schedulable !== false);
    if (schedulable.length <= 1) return null;

    // Session-affinity short-circuit (ahead of the sort).
    if (input.sessionKey) {
      const aKey = scopedKey(input.providerId, input.sessionKey);
      const hit = this.affinity.get(aKey);
      if (hit && hit.expiresAt > now && schedulable.some((a) => a.id === hit.accountId)) {
        hit.expiresAt = now + SESSION_AFFINITY_TTL_MS;
        this.markUsed(input.providerId, hit.accountId, now);
        return { accountId: hit.accountId, isActive: hit.accountId === input.activeAccountId };
      }
    }

    const chosen = this.pickOrdered(input.providerId, schedulable);
    this.markUsed(input.providerId, chosen.id, now);
    if (input.sessionKey) {
      this.affinity.set(scopedKey(input.providerId, input.sessionKey), {
        accountId: chosen.id,
        expiresAt: now + SESSION_AFFINITY_TTL_MS,
      });
    }
    return { accountId: chosen.id, isActive: chosen.id === input.activeAccountId };
  }

  /**
   * Drop every session-affinity mapping bound to this account (subscription-account-
   * health, task 4.1). Called when a selected account's by-id token turns out
   * null/invalid or an affinity-bound account becomes unhealthy, so the next
   * selection for those sessions picks a fresh account instead of re-sticking to
   * the bad one. O(affinity entries) — the map is tiny (one entry per live
   * conversation).
   */
  evictAffinity(providerId: SubscriptionProviderId, accountId: string): void {
    const prefix = `${providerId} `;
    for (const [key, entry] of this.affinity) {
      if (entry.accountId === accountId && key.startsWith(prefix)) {
        this.affinity.delete(key);
      }
    }
  }

  /**
   * Whether a best-effort `lastUsedAt` durable persist is DUE for this account
   * (≥ `LAST_USED_PERSIST_THROTTLE_MS` since the last one). Records the persist
   * time when it returns `true`, so the strategy calls `touchAccountLastUsed`
   * sparingly and the request hot path does not rewrite the store every request.
   */
  duePersist(providerId: SubscriptionProviderId, accountId: string, now: number = Date.now()): boolean {
    const key = scopedKey(providerId, accountId);
    const last = this.lastPersist.get(key) ?? 0;
    if (now - last < LAST_USED_PERSIST_THROTTLE_MS) return false;
    this.lastPersist.set(key, now);
    return true;
  }

  /** Sort by `priority` asc → effective `lastUsedAt` asc → `createdAt` asc → `[0]`. */
  private pickOrdered(
    providerId: SubscriptionProviderId,
    accounts: readonly SchedulableAccount[],
  ): SchedulableAccount {
    const ranked = accounts.map((account) => ({
      account,
      priority: account.priority ?? DEFAULT_ACCOUNT_PRIORITY,
      lastUsed: this.effectiveLastUsed(providerId, account),
      created: parseIso(account.createdAt),
    }));
    ranked.sort(
      (x, y) => x.priority - y.priority || x.lastUsed - y.lastUsed || x.created - y.created,
    );
    return ranked[0].account;
  }

  /** The live tie-break value: the in-memory overlay when set, else the persisted
   *  `lastUsedAt` (0 when absent). */
  private effectiveLastUsed(providerId: SubscriptionProviderId, account: SchedulableAccount): number {
    const overlay = this.lastUsedOverlay.get(scopedKey(providerId, account.id));
    return overlay ?? parseIso(account.lastUsedAt);
  }

  private markUsed(providerId: SubscriptionProviderId, accountId: string, now: number): void {
    this.lastUsedOverlay.set(scopedKey(providerId, accountId), now);
  }
}
