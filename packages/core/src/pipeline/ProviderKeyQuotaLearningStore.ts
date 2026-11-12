/**
 * ProviderKeyQuotaLearningStore — passively-observed BYO provider-key quota
 * evidence, keyed by provider row + pool key id.
 *
 * The daemon's `ProviderKeyQuotaService` polls usage endpoints on a 5-minute
 * read-through cache; this store is the SERVING-PATH complement: quota facts
 * extracted from real upstream 429 responses (see
 * `zaiRateLimitDetection`) land here within the request that hit the wall, so
 * the quota surface stays accurate between polls and survives a poll that
 * cannot run (e.g. a key whose plan expired).
 *
 * Entries are intentionally EPHEMERAL: no persistence (a restart re-learns on
 * the next 429 or falls back to the poll), a short observed-at TTL, and
 * per-window expiry at each window's own reset instant. All content is
 * secret-free by construction — codes, percentages, and timestamps only; the
 * raw body and any credential never enter.
 *
 * @module pipeline/ProviderKeyQuotaLearningStore
 */

import type {
  ZaiRateLimitDiagnostic,
  ZaiRateLimitObservation,
} from '../provider-proxy/ingress/zaiRateLimitDetection';

/** Bounded entry TTL: long enough to bridge poll gaps, short enough that a
 * stale diagnostic cannot linger after the account state changed. */
export const PROVIDER_KEY_QUOTA_LEARNING_TTL_MS = 10 * 60_000;

/** Hard cap on tracked (row, key) pairs — defense against unbounded growth. */
const MAX_ENTRIES = 512;

/** One learned window, normalized (no provider-specific id scheme here). */
export interface LearnedQuotaWindow {
  /** Window length when known; matched by the daemon quota layer. */
  windowMinutes?: number;
  /** Absolute reset instant, epoch ms. */
  resetsAtMs: number;
  usedPercent: 100;
}

/** The projected (expiry-applied) view of one key's learned evidence. */
export interface LearnedQuotaEntry {
  rowId: string;
  keyId: string;
  windows: LearnedQuotaWindow[];
  diagnostic?: ZaiRateLimitDiagnostic;
  observedAt: string;
}

function entryKey(rowId: string, keyId: string): string {
  return `${rowId}\0${keyId}`;
}

interface StoredEntry {
  rowId: string;
  keyId: string;
  windows: LearnedQuotaWindow[];
  diagnostic?: ZaiRateLimitDiagnostic;
  observedMs: number;
}

/** In-memory learning store shared by serving (the egress tap) and the admin
 * quota read path. Not a `ProviderProxyDeps` member — it is ambient telemetry
 * state, like the allowance store and route activity, never per-request. */
export class ProviderKeyQuotaLearningStore {
  private readonly entries = new Map<string, StoredEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Merge one observation into the (rowId, keyId) entry. New windows replace
   *  same-length ones; a diagnostic replaces the previous one. Best-effort by
   *  contract — callers wrap in try/catch so telemetry never breaks egress. */
  record(
    rowId: string,
    keyId: string,
    observation: ZaiRateLimitObservation,
    observedMs: number = this.now(),
  ): void {
    if (!rowId || !keyId) return;
    if (observation.windows.length === 0 && observation.diagnostic === undefined) return;
    this.prune(observedMs);

    const key = entryKey(rowId, keyId);
    const previous = this.entries.get(key);
    const windows: LearnedQuotaWindow[] = [...(previous?.windows ?? [])];
    for (const observed of observation.windows) {
      // A fresh 429 is strictly newer evidence than anything stored for the
      // same window length; unknown-length windows never replace a known one.
      const index = observed.windowMinutes !== undefined
        ? windows.findIndex((w) => w.windowMinutes === observed.windowMinutes)
        : -1;
      if (index >= 0) windows[index] = { ...observed };
      else if (observed.windowMinutes !== undefined || windows.length === 0) {
        // Keep at most one unknown-length window, and only when there is
        // nothing better — a length-less wall is a last-resort card.
        windows.push({ ...observed });
      }
    }
    const diagnostic = observation.diagnostic ?? previous?.diagnostic;
    this.entries.set(key, {
      rowId,
      keyId,
      windows: windows
        .filter((w) => w.resetsAtMs > observedMs)
        .sort((a, b) => (a.windowMinutes ?? Number.POSITIVE_INFINITY) - (b.windowMinutes ?? Number.POSITIVE_INFINITY))
        .slice(0, 4),
      ...(diagnostic !== undefined ? { diagnostic } : {}),
      observedMs,
    });
  }

  /** The (expiry-applied) learned evidence for one key, or `null`. */
  lookup(rowId: string, keyId: string, now: number = this.now()): LearnedQuotaEntry | null {
    const stored = this.entries.get(entryKey(rowId, keyId));
    if (!stored) return null;
    return this.project(stored, now) ?? null;
  }

  /** Drop entries whose observation aged past the TTL (windows whose reset
   *  already passed are dropped at projection time, not here). */
  prune(now: number = this.now()): void {
    const cutoff = now - PROVIDER_KEY_QUOTA_LEARNING_TTL_MS;
    for (const [key, entry] of this.entries) {
      if (entry.observedMs < cutoff) this.entries.delete(key);
    }
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = [...this.entries.values()].sort((a, b) => a.observedMs - b.observedMs)[0];
      if (!oldest) break;
      this.entries.delete(entryKey(oldest.rowId, oldest.keyId));
    }
  }

  private project(entry: StoredEntry, now: number): LearnedQuotaEntry | undefined {
    const windows = entry.windows.filter((w) => w.resetsAtMs > now);
    if (windows.length === 0 && entry.diagnostic === undefined) return undefined;
    if (entry.observedMs < now - PROVIDER_KEY_QUOTA_LEARNING_TTL_MS) return undefined;
    return {
      rowId: entry.rowId,
      keyId: entry.keyId,
      windows,
      ...(entry.diagnostic !== undefined ? { diagnostic: entry.diagnostic } : {}),
      observedAt: new Date(entry.observedMs).toISOString(),
    };
  }

  clear(): void {
    this.entries.clear();
  }
}

let sharedLearningStore: ProviderKeyQuotaLearningStore | null = null;

export function getSharedProviderKeyQuotaLearningStore(): ProviderKeyQuotaLearningStore {
  if (!sharedLearningStore) sharedLearningStore = new ProviderKeyQuotaLearningStore();
  return sharedLearningStore;
}

/** Test seam — restore the pristine shared singleton between suites. */
export function __resetSharedProviderKeyQuotaLearningStoreForTests(): void {
  sharedLearningStore = null;
}
