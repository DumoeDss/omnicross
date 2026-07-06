/**
 * Unit tests for the in-memory per-key spend tracker (`outbound-key-policy`,
 * design D3): lazy seed from the durable store, O(1) increment via `add`,
 * daily-window roll, and restart re-seed.
 */
import { describe, expect, it } from 'vitest';

import {
  KeySpendTracker,
  type KeySpendSeeder,
  startOfLocalDay,
  startOfLocalWeek,
} from '../keySpendTracker';

/**
 * A seeder whose `getSpendByKey` computes all three windows in ONE pass over a
 * fixed set of `{ apiKeyId, ts, cost }` (mirrors the real single-scan store).
 */
function makeSeeder(events: Array<{ apiKeyId: string; ts: number; cost: number }>): KeySpendSeeder & {
  calls: number;
} {
  return {
    calls: 0,
    async getSpendByKey({ apiKeyId, dayStartTs, weekStartTs, endTs }) {
      this.calls += 1;
      let totalUsd = 0;
      let dailyUsd = 0;
      let weeklyUsd = 0;
      for (const e of events) {
        if (e.apiKeyId !== apiKeyId || e.ts >= endTs) continue;
        totalUsd += e.cost;
        if (e.ts >= dayStartTs) dailyUsd += e.cost;
        if (e.ts >= weekStartTs) weeklyUsd += e.cost;
      }
      return { totalUsd, dailyUsd, weeklyUsd };
    },
  };
}

describe('KeySpendTracker', () => {
  it('lazily seeds total/daily/weekly from the store on first read, then serves O(1)', async () => {
    const now = startOfLocalDay(Date.now()) + 3_600_000; // 1h into today
    const seeder = makeSeeder([
      { apiKeyId: 'k', ts: now - 10 * 86_400_000, cost: 7 }, // old (total only)
      { apiKeyId: 'k', ts: now - 1_000, cost: 3 }, // today
      { apiKeyId: 'other', ts: now - 1_000, cost: 99 }, // different key — never counted
    ]);
    const tracker = new KeySpendTracker(seeder);

    const first = await tracker.getSpend('k', now);
    expect(first.totalUsd).toBe(10);
    expect(first.dailyUsd).toBe(3);
    // The seed is a SINGLE scan (all three windows in one call), not three.
    expect(seeder.calls).toBe(1);

    // Second read (same window) hits the cache — no further store scans.
    await tracker.getSpend('k', now);
    expect(seeder.calls).toBe(1);
  });

  it('single-pass seed matches per-window sums (daily ⊆ weekly ⊆ total)', async () => {
    const day = startOfLocalDay(Date.now());
    const now = day + 12 * 3_600_000;
    const week = startOfLocalWeek(now);
    const seeder = makeSeeder([
      { apiKeyId: 'k', ts: week - 100, cost: 5 }, // before this week → total only
      { apiKeyId: 'k', ts: week + 100, cost: 7 }, // this week, before today → weekly+total
      { apiKeyId: 'k', ts: day + 100, cost: 11 }, // today → daily+weekly+total
    ]);
    const s = await new KeySpendTracker(seeder).getSpend('k', now);
    expect(s.dailyUsd).toBe(11);
    expect(s.weeklyUsd).toBe(18);
    expect(s.totalUsd).toBe(23);
    expect(seeder.calls).toBe(1);
  });

  it('add() increments the live aggregate with no re-scan', async () => {
    const now = startOfLocalDay(Date.now()) + 3_600_000;
    const seeder = makeSeeder([]);
    const tracker = new KeySpendTracker(seeder);
    await tracker.getSpend('k', now); // seed (all zero)
    tracker.add('k', 2.5, now);
    tracker.add('k', 1.5, now);
    const s = await tracker.getSpend('k', now);
    expect(s.dailyUsd).toBe(4);
    expect(s.totalUsd).toBe(4);
  });

  it('add() before seed is a no-op (later seed picks it up from the store)', async () => {
    const now = startOfLocalDay(Date.now()) + 3_600_000;
    // The store already has the record; add() before seed must not double count.
    const seeder = makeSeeder([{ apiKeyId: 'k', ts: now - 1, cost: 5 }]);
    const tracker = new KeySpendTracker(seeder);
    tracker.add('k', 5, now); // dropped (not seeded yet)
    const s = await tracker.getSpend('k', now);
    expect(s.totalUsd).toBe(5); // from the store, not 10
  });

  it('rolls the daily window at local midnight (daily resets, total persists)', async () => {
    const today = startOfLocalDay(Date.now());
    const seeder = makeSeeder([]);
    const tracker = new KeySpendTracker(seeder);
    await tracker.getSpend('k', today + 3_600_000);
    tracker.add('k', 8, today + 3_600_000);
    expect((await tracker.getSpend('k', today + 3_600_000)).dailyUsd).toBe(8);

    // Next day: the daily sub-total resets, the lifetime total is retained.
    const tomorrow = startOfLocalDay(today + 26 * 3_600_000);
    const next = await tracker.getSpend('k', tomorrow + 3_600_000);
    expect(next.dailyUsd).toBe(0);
    expect(next.totalUsd).toBe(8);
  });

  it('re-seeds total from the durable store after a restart (fresh instance)', async () => {
    const now = startOfLocalDay(Date.now()) + 3_600_000;
    const events = [{ apiKeyId: 'k', ts: now - 100, cost: 42 }];
    const seeder = makeSeeder(events);
    // A brand-new tracker (post-restart) with no in-memory state.
    const rebooted = new KeySpendTracker(seeder);
    const s = await rebooted.getSpend('k', now);
    expect(s.totalUsd).toBe(42);
  });
});
