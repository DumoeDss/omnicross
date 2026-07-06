/**
 * Unit tests for the per-key concurrency gate (`omnicross-uqc-core`, task 6.2):
 * within-limit grants, over-limit FIFO queue + drain, queue-full reject,
 * wait-timeout reject, cancel (disconnect) removes a waiter and serves the next,
 * idempotent release/cancel (no double-decrement), and the `getStatus`
 * snapshot. Fake timers drive the wait-timeout; grants resolve synchronously.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConcurrencyQueueFullError,
  ConcurrencyWaitCancelledError,
  ConcurrencyWaitTimeoutError,
  OutboundConcurrencyGate,
} from '../outboundConcurrencyGate';

const OPTS = { maxQueueSizeFactor: 2, minQueueSize: 4, waitTimeoutMs: 10_000 };

describe('OutboundConcurrencyGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('grants immediately while under the limit', async () => {
    const gate = new OutboundConcurrencyGate();
    const s1 = await gate.acquire('k', 2, OPTS).granted;
    const s2 = await gate.acquire('k', 2, OPTS).granted;
    expect(gate.getStatus()).toEqual([{ apiKeyId: 'k', active: 2, waiting: 0 }]);
    s1.release();
    s2.release();
  });

  it('queues over the limit and drains waiters in FIFO order', async () => {
    const gate = new OutboundConcurrencyGate();
    const s1 = await gate.acquire('k', 1, OPTS).granted;
    const order: number[] = [];
    const a2 = gate.acquire('k', 1, OPTS);
    const a3 = gate.acquire('k', 1, OPTS);
    void a2.granted.then(() => order.push(2));
    void a3.granted.then(() => order.push(3));
    expect(gate.getStatus()).toEqual([{ apiKeyId: 'k', active: 1, waiting: 2 }]);

    s1.release();
    const s2 = await a2.granted;
    s2.release();
    const s3 = await a3.granted;
    s3.release();
    expect(order).toEqual([2, 3]);
  });

  it('rejects queue-full once the per-key cap is reached', async () => {
    const gate = new OutboundConcurrencyGate();
    // cap = max(1*1, 1) = 1 queued slot.
    const opts = { maxQueueSizeFactor: 1, minQueueSize: 1, waitTimeoutMs: 10_000 };
    const s1 = await gate.acquire('k', 1, opts).granted; // active
    const a2 = gate.acquire('k', 1, opts); // 1 queued (fills the cap)
    const a3 = gate.acquire('k', 1, opts); // queue-full → reject
    await expect(a3.granted).rejects.toBeInstanceOf(ConcurrencyQueueFullError);

    // The first waiter is unaffected and still served.
    s1.release();
    const s2 = await a2.granted;
    s2.release();
  });

  it('rejects a queued waiter after the wait-timeout', async () => {
    const gate = new OutboundConcurrencyGate();
    const s1 = await gate.acquire('k', 1, { ...OPTS, waitTimeoutMs: 500 }).granted;
    let err: unknown = null;
    gate
      .acquire('k', 1, { ...OPTS, waitTimeoutMs: 500 })
      .granted.catch((e) => {
        err = e;
      });
    await vi.advanceTimersByTimeAsync(500);
    expect(err).toBeInstanceOf(ConcurrencyWaitTimeoutError);
    s1.release();
  });

  it('cancel removes a still-pending waiter and the next waiter is served', async () => {
    const gate = new OutboundConcurrencyGate();
    const s1 = await gate.acquire('k', 1, OPTS).granted;
    const a2 = gate.acquire('k', 1, OPTS);
    const a3 = gate.acquire('k', 1, OPTS);

    a2.cancel(); // client for a2 disconnects mid-queue
    await expect(a2.granted).rejects.toBeInstanceOf(ConcurrencyWaitCancelledError);
    expect(gate.getStatus()).toEqual([{ apiKeyId: 'k', active: 1, waiting: 1 }]);

    s1.release(); // frees the slot → a3 (now head) served
    const s3 = await a3.granted;
    expect(s3).toBeDefined();
    s3.release();
  });

  it('release and cancel are idempotent (no double-decrement / no underflow)', async () => {
    const gate = new OutboundConcurrencyGate();
    const a1 = gate.acquire('k', 2, OPTS);
    const s1 = await a1.granted;
    const s2 = await gate.acquire('k', 2, OPTS).granted;
    expect(gate.getStatus()).toEqual([{ apiKeyId: 'k', active: 2, waiting: 0 }]);

    s1.release();
    s1.release(); // double-fire (finally + res.close) must not decrement twice
    a1.cancel(); // post-grant cancel is a no-op
    expect(gate.getStatus()).toEqual([{ apiKeyId: 'k', active: 1, waiting: 0 }]);

    s2.release();
    expect(gate.getStatus()).toEqual([]); // fully idle → dropped from the snapshot
  });

  it('treats limit <= 0 as unlimited (always grants, never queues)', async () => {
    const gate = new OutboundConcurrencyGate();
    const s1 = await gate.acquire('k', 0, OPTS).granted;
    const s2 = await gate.acquire('k', 0, OPTS).granted;
    const s3 = await gate.acquire('k', 0, OPTS).granted;
    expect(gate.getStatus()).toEqual([{ apiKeyId: 'k', active: 3, waiting: 0 }]);
    s1.release();
    s2.release();
    s3.release();
  });
});
