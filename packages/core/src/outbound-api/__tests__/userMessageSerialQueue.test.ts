/**
 * Unit tests for the per-provider user-message serial queue
 * (`omnicross-uqc-core`, task 6.1): FIFO order, `delayMs` spacing, independent
 * keys, wait-timeout isolation, and the `getStatus` snapshot.
 *
 * Uses fake timers so the residual `delayMs` dispatch and the wait-timeout are
 * deterministic (the primitive schedules with `setTimeout` + reads `Date.now`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isSerialQueueTimeout,
  SerialQueueTimeoutError,
  UserMessageSerialQueue,
} from '../userMessageSerialQueue';

describe('UserMessageSerialQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serializes and drains waiters in strict FIFO order per key', async () => {
    const q = new UserMessageSerialQueue();
    const opts = { waitTimeoutMs: 10_000, delayMs: 0 };
    const order: number[] = [];

    const s1 = await q.acquire('p', opts); // granted immediately
    const p2 = q.acquire('p', opts).then((s) => {
      order.push(2);
      return s;
    });
    const p3 = q.acquire('p', opts).then((s) => {
      order.push(3);
      return s;
    });

    s1.release();
    const s2 = await p2;
    s2.release();
    const s3 = await p3;
    s3.release();

    expect(order).toEqual([2, 3]);
  });

  it('enforces the delayMs gap between one key’s releases', async () => {
    const q = new UserMessageSerialQueue();
    const opts = { waitTimeoutMs: 10_000, delayMs: 200 };

    const s1 = await q.acquire('p', opts);
    s1.release(); // lastReleaseTs = now (0)

    let granted2 = false;
    const p2 = q.acquire('p', opts).then((s) => {
      granted2 = true;
      return s;
    });

    await vi.advanceTimersByTimeAsync(199);
    expect(granted2).toBe(false); // still inside the 200ms gap
    await vi.advanceTimersByTimeAsync(1);
    expect(granted2).toBe(true);
    (await p2).release();
  });

  it('keeps distinct keys independent (one held key does not block another)', async () => {
    const q = new UserMessageSerialQueue();
    const opts = { waitTimeoutMs: 10_000, delayMs: 0 };

    const a = await q.acquire('a', opts); // holds 'a'
    const b = await q.acquire('b', opts); // 'b' granted despite 'a' held
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    a.release();
    b.release();
  });

  it('wait-timeout rejects a waiter without disturbing the ones behind it', async () => {
    const q = new UserMessageSerialQueue();
    const s1 = await q.acquire('p', { waitTimeoutMs: 10_000, delayMs: 0 }); // holds

    let p2Err: unknown = null;
    q.acquire('p', { waitTimeoutMs: 500, delayMs: 0 }).catch((e) => {
      p2Err = e;
    });
    // A waiter behind the one that will time out, with a longer patience.
    const p3 = q.acquire('p', { waitTimeoutMs: 10_000, delayMs: 0 });

    await vi.advanceTimersByTimeAsync(500);
    expect(p2Err).toBeInstanceOf(SerialQueueTimeoutError);
    expect(isSerialQueueTimeout(p2Err)).toBe(true);

    // p3 is untouched and is served when the head releases.
    s1.release();
    const s3 = await p3;
    expect(s3).toBeDefined();
    s3.release();
  });

  it('clears a stale dispatch timer on a direct grant so the next waiter still honors delayMs (Finding 1 regression)', async () => {
    // Deterministically reconstructs the event-loop-lag race the reviewer
    // flagged, exploiting how this suite's fake timers behave: the TIMER clock
    // (what fires `setTimeout`, advanced only by `advanceTimersByTime`) is
    // SEPARATE from `Date` (moved by `setSystemTime` WITHOUT advancing timers).
    // That decoupling is exactly the lever — it lets `Date` jump past a pending
    // dispatch timer's wall deadline (so a re-entry hits the `residual<=0`
    // direct-grant path) while the timer itself stays pending on the timer
    // clock. To make the stale vs. fresh dispatch fire at DIFFERENT timer ticks
    // (so the bug is observable), the timer clock is advanced 50 BETWEEN
    // scheduling the stale timer and the release:
    //   • stale dispatch (for w2) is armed at timer-tick 0 → fires at tick 200.
    //   • after advancing to tick 50, the release re-arms a FRESH dispatch (for
    //     w3) at tick 50 → fires at tick 250.
    // With the fix the stale timer is cleared on the direct grant, so w3 is
    // served at tick 250. WITHOUT the fix the release short-circuits (a stale
    // handle is still set) and w3 rides the stale tick-200 timer — served ~50
    // ticks early, bypassing the fresh `delayMs` gap. The assertion at tick 200
    // distinguishes the two. (Seed `Date` to 0 first, else it starts at the real
    // epoch and `setSystemTime(200)` moves time backwards → elapsed negative.)
    const q = new UserMessageSerialQueue();
    const opts = { waitTimeoutMs: 10_000, delayMs: 200 };
    vi.setSystemTime(0);

    const s1 = await q.acquire('p', opts); // holds; Date=0, timer-tick=0
    const w2 = q.acquire('p', opts); // queued
    s1.release(); // arms the stale dispatch for w2 → fires at timer-tick 200

    await vi.advanceTimersByTimeAsync(50); // timer-tick → 50 (stale timer still pending)
    vi.setSystemTime(200); // Date jumps past the stale timer's wall deadline (tick unchanged)
    const w3 = q.acquire('p', opts); // Date=200 → residual<=0 → direct grantHead(w2)
    const s2 = await w2; // w2 granted synchronously; the fix must clear the stale timer here

    let w3Granted = false;
    void w3.then((s) => {
      w3Granted = true;
      s.release();
    });

    s2.release(); // re-arms a FRESH dispatch for w3 at tick 50 → should fire at tick 250
    await vi.advanceTimersByTimeAsync(150); // timer-tick → 200: the STALE timer's deadline
    expect(w3Granted).toBe(false); // fix: fresh timer (tick 250) not due; pre-fix: stale fired here
    await vi.advanceTimersByTimeAsync(50); // timer-tick → 250: the fresh deadline
    expect(w3Granted).toBe(true); // served at the correct fresh delayMs boundary
  });

  it('getStatus reflects only keys that hold a slot or have waiters', async () => {
    const q = new UserMessageSerialQueue();
    expect(q.getStatus()).toEqual([]);

    const opts = { waitTimeoutMs: 10_000, delayMs: 0 };
    const s1 = await q.acquire('p', opts);
    expect(q.getStatus()).toEqual([{ providerId: 'p', holding: true, waiting: 0 }]);

    const p2 = q.acquire('p', opts);
    expect(q.getStatus()).toEqual([{ providerId: 'p', holding: true, waiting: 1 }]);

    s1.release();
    const s2 = await p2;
    expect(q.getStatus()).toEqual([{ providerId: 'p', holding: true, waiting: 0 }]);
    s2.release();
    // Idle key (released, no waiters) drops out of the active snapshot.
    expect(q.getStatus()).toEqual([]);
  });
});
