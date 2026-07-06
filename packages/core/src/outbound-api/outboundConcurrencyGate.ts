/**
 * outboundConcurrencyGate — per-`apiKeyId` concurrency queue for the outbound
 * API server (queue/concurrency, design D-CORE-2).
 *
 * An outbound key over its concurrency ceiling should WAIT its turn rather than
 * get a hard 429. This primitive is a per-key counting semaphore (`limit` =
 * the key's `maxConcurrency`) fronting a bounded FIFO wait queue: within limit
 * → grant; over limit but under `max(limit*factor, minQueueSize)` → enqueue;
 * beyond that → reject queue-full. Waiters resolve in strict FIFO order and a
 * waiter can be CANCELLED (the wire layer binds this to `res.close` so a client
 * that disconnects mid-queue frees its spot). Release + cancel are idempotent
 * (guarded by a per-acquisition `settled` flag) so the wire's `finally` +
 * `res.once('close')` double-fire is safe — this directly avoids the CRS #1130
 * slot leak.
 *
 * Memory-only, injected clock, resets on restart. `limit <= 0` means unlimited
 * (the wire layer bypasses the gate entirely for such keys; a defensive call
 * here still grants immediately without bound).
 *
 * NOTE ON THE ACQUIRE SHAPE: the design task sketched `acquire → Promise<{
 * release, cancel }>`, but the wire layer must be able to CANCEL a still-pending
 * wait (bind `res.once('close', cancel)` BEFORE the grant resolves). A bare
 * promise only hands back its value on grant, so `acquire` instead returns a
 * synchronous {@link GateAcquisition} handle exposing both `cancel()` and a
 * `granted` promise; the granted {@link GateSlot} also carries `release` AND
 * `cancel` (the same idempotent fns) so the sketched shape is still satisfied
 * post-grant. (Deviation recorded in the change return notes.)
 *
 * @module outbound-api/outboundConcurrencyGate
 */

/** A granted concurrency slot. `release` frees it; `cancel` is a post-grant no-op. */
export interface GateSlot {
  release(): void;
  cancel(): void;
}

/** The synchronous handle `acquire` returns (so a pending wait can be cancelled). */
export interface GateAcquisition {
  /** Resolves with a {@link GateSlot} on grant; rejects on queue-full/timeout/cancel. */
  granted: Promise<GateSlot>;
  /** Cancel a still-pending wait (idempotent; no-op once granted). */
  cancel(): void;
}

/** Options for one `acquire`. */
export interface GateAcquireOptions {
  /** Per-key max queued = `max(limit*factor, minQueueSize)`. */
  maxQueueSizeFactor: number;
  /** Floor of the per-key max queued. */
  minQueueSize: number;
  /** Reject a queued waiter after this many ms (wire → 429). */
  waitTimeoutMs: number;
}

/** A per-key snapshot entry (only keys with active slots or waiters). */
export interface GateStatusEntry {
  apiKeyId: string;
  active: number;
  waiting: number;
}

/** Rejection thrown when a key's wait queue is full at acquire time. */
export class ConcurrencyQueueFullError extends Error {
  readonly code = 'concurrency_queue_full';
  constructor(
    readonly apiKeyId: string,
    readonly maxQueueSize: number,
  ) {
    super(`concurrency queue full (max ${maxQueueSize}) for key '${apiKeyId}'`);
    this.name = 'ConcurrencyQueueFullError';
  }
}

/** Rejection thrown when a queued waiter exceeds `waitTimeoutMs`. */
export class ConcurrencyWaitTimeoutError extends Error {
  readonly code = 'concurrency_wait_timeout';
  constructor(
    readonly apiKeyId: string,
    readonly waitTimeoutMs: number,
  ) {
    super(`concurrency wait timed out after ${waitTimeoutMs}ms for key '${apiKeyId}'`);
    this.name = 'ConcurrencyWaitTimeoutError';
  }
}

/** Rejection thrown when a still-pending wait is cancelled (client disconnect). */
export class ConcurrencyWaitCancelledError extends Error {
  readonly code = 'concurrency_wait_cancelled';
  constructor(readonly apiKeyId: string) {
    super(`concurrency wait cancelled for key '${apiKeyId}'`);
    this.name = 'ConcurrencyWaitCancelledError';
  }
}

/** True for any rejection the gate produces on an acquire that never granted. */
export function isConcurrencyRejection(
  err: unknown,
): err is ConcurrencyQueueFullError | ConcurrencyWaitTimeoutError | ConcurrencyWaitCancelledError {
  return (
    err instanceof ConcurrencyQueueFullError ||
    err instanceof ConcurrencyWaitTimeoutError ||
    err instanceof ConcurrencyWaitCancelledError
  );
}

interface GateWaiter {
  /** The cap this waiter was admitted under (the key's `limit`). */
  readonly cap: number;
  grant(): void;
  /** Remove from the queue + reject with the given error (idempotent-checked by caller). */
  fail(err: Error): void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

interface GateKeyState {
  active: number;
  waiters: GateWaiter[];
}

/**
 * Per-`apiKeyId` counting semaphore + bounded FIFO wait queue.
 */
export class OutboundConcurrencyGate {
  private readonly states = new Map<string, GateKeyState>();

  private ensure(apiKeyId: string): GateKeyState {
    let state = this.states.get(apiKeyId);
    if (!state) {
      state = { active: 0, waiters: [] };
      this.states.set(apiKeyId, state);
    }
    return state;
  }

  /** Delete a key's state once it is fully idle (no active, no waiters). */
  private gc(apiKeyId: string): void {
    const state = this.states.get(apiKeyId);
    if (state && state.active === 0 && state.waiters.length === 0) {
      this.states.delete(apiKeyId);
    }
  }

  /**
   * Acquire a concurrency slot for `apiKeyId` under `limit`. Grants immediately
   * when `active < limit`; else enqueues FIFO while under the per-key queue cap;
   * else rejects queue-full. `limit <= 0` = unlimited (always granted).
   */
  acquire(apiKeyId: string, limit: number, options: GateAcquireOptions): GateAcquisition {
    const state = this.ensure(apiKeyId);
    const cap = limit > 0 ? limit : Infinity;

    // Immediate grant.
    if (state.active < cap) {
      state.active += 1;
      const slot = this.makeSlot(apiKeyId);
      return { granted: Promise.resolve(slot), cancel: slot.cancel };
    }

    // Bounded FIFO enqueue.
    const maxQueueSize = Math.max(
      Number.isFinite(cap) ? cap * options.maxQueueSizeFactor : Infinity,
      options.minQueueSize,
    );
    if (state.waiters.length >= maxQueueSize) {
      const err = new ConcurrencyQueueFullError(apiKeyId, maxQueueSize);
      return { granted: Promise.reject(err), cancel: () => {} };
    }

    let settled = false;
    let granted = false;
    let resolveGrant!: (slot: GateSlot) => void;
    let rejectGrant!: (err: Error) => void;
    const grantedPromise = new Promise<GateSlot>((resolve, reject) => {
      resolveGrant = resolve;
      rejectGrant = reject;
    });

    const waiter: GateWaiter = {
      cap,
      settled: false,
      timeoutHandle: null,
      grant: () => {
        if (settled) return;
        settled = true;
        granted = true;
        waiter.settled = true;
        if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle);
        state.active += 1;
        resolveGrant(this.makeSlot(apiKeyId));
      },
      fail: (err: Error) => {
        if (settled) return;
        settled = true;
        waiter.settled = true;
        if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle);
        const idx = state.waiters.indexOf(waiter);
        if (idx >= 0) state.waiters.splice(idx, 1);
        rejectGrant(err);
        this.gc(apiKeyId);
      },
    };

    waiter.timeoutHandle = setTimeout(() => {
      waiter.fail(new ConcurrencyWaitTimeoutError(apiKeyId, options.waitTimeoutMs));
    }, options.waitTimeoutMs);
    state.waiters.push(waiter);

    const cancel = (): void => {
      if (settled || granted) return; // already resolved/rejected, or granted → release handles it
      waiter.fail(new ConcurrencyWaitCancelledError(apiKeyId));
    };

    return { granted: grantedPromise, cancel };
  }

  /** Build an idempotent granted slot (`release` decrements; `cancel` is a no-op). */
  private makeSlot(apiKeyId: string): GateSlot {
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const state = this.states.get(apiKeyId);
      if (!state) return;
      state.active = Math.max(0, state.active - 1);
      this.dispatchNext(apiKeyId);
      this.gc(apiKeyId);
    };
    // Post-grant cancel is a no-op — a granted slot is freed via `release`.
    return { release, cancel: () => {} };
  }

  /** After a release freed a slot, grant the FIFO head if it fits under its cap. */
  private dispatchNext(apiKeyId: string): void {
    const state = this.states.get(apiKeyId);
    if (!state || state.waiters.length === 0) return;
    const head = state.waiters[0];
    if (state.active < head.cap) {
      state.waiters.shift();
      head.grant();
    }
  }

  /** Snapshot for observability — only keys with active slots or waiters. */
  getStatus(): GateStatusEntry[] {
    const out: GateStatusEntry[] = [];
    for (const [apiKeyId, state] of this.states) {
      if (state.active > 0 || state.waiters.length > 0) {
        out.push({ apiKeyId, active: state.active, waiting: state.waiters.length });
      }
    }
    return out;
  }

  /** Drop all state + pending timers (tests / teardown). */
  reset(): void {
    for (const state of this.states.values()) {
      for (const w of state.waiters) {
        if (w.timeoutHandle) clearTimeout(w.timeoutHandle);
      }
    }
    this.states.clear();
  }
}
