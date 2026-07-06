/**
 * keySpendTracker — a cheap in-memory per-key accumulated-spend cache
 * (`outbound-key-policy`, design D3).
 *
 * The request-path cost check MUST NOT scan the usage log. This tracker keeps an
 * O(1) per-`apiKeyId` aggregate:
 *  - LAZY SEED: on the first `getSpend` for a key (cache miss), it derives that
 *    key's total / today's / this-week's spend from the durable usage store via
 *    the injected {@link KeySpendSeeder} — ONE query per newly-seen key, NOT per
 *    request. Because it re-seeds from the store, `totalUsd` survives a restart
 *    (the jsonl IS the durable source; this is just a hot cache).
 *  - INCREMENT: `add(id, cost, now)` is wired to `UsageRecorder`'s per-request
 *    record hook, so every recorded request updates the aggregate with no scan.
 *  - WINDOW ROLL: `getSpend`/`add` roll the daily window at local midnight and
 *    the weekly window at the local week start before reading/incrementing.
 *
 * @module outbound-api/keySpendTracker
 */

import type { KeySpend } from './keyPolicy';

/**
 * Reader the wire layer depends on (structural). Kept minimal so a test double —
 * or a future indexed impl — is trivial and the router needs no concrete class.
 */
export interface KeySpendReader {
  getSpend(apiKeyId: string, now: number): Promise<KeySpend>;
}

/**
 * Durable-store seed source (design D3). ONE scan of a single key's events
 * returns all three spend windows (`totalUsd` + `dailyUsd` from `dayStartTs` +
 * `weeklyUsd` from `weekStartTs`, all `ts < endTs`). One call per newly-seen key.
 */
export interface KeySpendSeeder {
  getSpendByKey(query: {
    apiKeyId: string;
    dayStartTs: number;
    weekStartTs: number;
    endTs: number;
  }): Promise<{ totalUsd: number; dailyUsd: number; weeklyUsd: number }>;
}

/** Local-midnight boundary for `ts` (epoch ms). */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Local week-start boundary for `ts` (Sunday 00:00 local) — the daily boundary
 * shifted back to the most recent Sunday.
 */
export function startOfLocalWeek(ts: number): number {
  const d = new Date(ts);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  day.setDate(day.getDate() - day.getDay()); // getDay(): 0 = Sunday
  return day.getTime();
}

export class KeySpendTracker implements KeySpendReader {
  /** apiKeyId → live accumulated spend (seeded lazily). */
  private readonly spend = new Map<string, KeySpend>();

  constructor(private readonly seeder: KeySpendSeeder) {}

  /**
   * Read the key's accumulated spend, seeding from the durable store on a cache
   * miss and rolling the daily/weekly windows on a hit.
   */
  async getSpend(apiKeyId: string, now: number): Promise<KeySpend> {
    const existing = this.spend.get(apiKeyId);
    if (existing) {
      rollWindows(existing, now);
      return existing;
    }
    const seeded = await this.seed(apiKeyId, now);
    // Re-check after awaiting the seed: a concurrent `getSpend` for the same key
    // may have finished seeding and its entry may already carry `add`-ed spend.
    // Discard this (now-redundant) freshly-seeded snapshot and keep the stored
    // entry so a racing increment is not clobbered.
    const existingAfterSeed = this.spend.get(apiKeyId);
    if (existingAfterSeed) {
      rollWindows(existingAfterSeed, now);
      return existingAfterSeed;
    }
    this.spend.set(apiKeyId, seeded);
    return seeded;
  }

  /**
   * Increment the aggregate for one recorded request. No-op when the key has not
   * been seeded yet — a later `getSpend` will lazy-seed from the durable store,
   * which already includes this record, so it is neither lost nor double-counted.
   */
  add(apiKeyId: string, costUsd: number, now: number): void {
    const s = this.spend.get(apiKeyId);
    if (!s) return;
    rollWindows(s, now);
    s.dailyUsd += costUsd;
    s.weeklyUsd += costUsd;
    s.totalUsd += costUsd;
  }

  /** Drop all cached spend (tests / teardown). */
  reset(): void {
    this.spend.clear();
  }

  /**
   * Derive a fresh spend snapshot for `apiKeyId` from the durable store in a
   * SINGLE scan (all three windows at once). `endTs` is EXCLUSIVE, so `now + 1`
   * includes a record stamped at exactly `now`.
   */
  private async seed(apiKeyId: string, now: number): Promise<KeySpend> {
    const dailyWindowStart = startOfLocalDay(now);
    const weeklyWindowStart = startOfLocalWeek(now);
    const { totalUsd, dailyUsd, weeklyUsd } = await this.seeder.getSpendByKey({
      apiKeyId,
      dayStartTs: dailyWindowStart,
      weekStartTs: weeklyWindowStart,
      endTs: now + 1,
    });
    return { dailyUsd, dailyWindowStart, weeklyUsd, weeklyWindowStart, totalUsd };
  }
}

/** Reset the daily/weekly sub-totals when their window boundary has advanced. */
function rollWindows(s: KeySpend, now: number): void {
  const day = startOfLocalDay(now);
  if (s.dailyWindowStart !== day) {
    s.dailyUsd = 0;
    s.dailyWindowStart = day;
  }
  const week = startOfLocalWeek(now);
  if (s.weeklyWindowStart !== week) {
    s.weeklyUsd = 0;
    s.weeklyWindowStart = week;
  }
}
