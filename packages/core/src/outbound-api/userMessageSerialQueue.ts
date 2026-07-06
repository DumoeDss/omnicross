/**
 * userMessageSerialQueue — per-`providerId` user-message serial queue for the
 * outbound API server (queue/concurrency, design D-CORE-1).
 *
 * A shared subscription account hit by concurrent user messages looks unlike a
 * single human and trips upstream risk-control. This primitive serializes the
 * REAL user-message turns for one upstream account (`providerId`): exactly one
 * in-flight at a time, plus a `delayMs` minimum gap between one account's
 * requests. Waiters resolve in strict FIFO order (correcting claude-relay-
 * service's non-fair Redis polling); no jitter, no busy-poll — the residual
 * `delayMs` gap is honored by a scheduled dispatch.
 *
 * Memory-only, resets on app restart (acceptable — the queue is a live
 * throttle, not persisted state). The caller RELEASES on response start (not
 * completion) so the next account request can begin while the prior response
 * streams; the release timestamp seeds the `delayMs` gap for the next waiter.
 * The wire layer (`omnicross-uqc-wire`) owns the `res` lifecycle; this module
 * never touches HTTP.
 *
 * @module outbound-api/userMessageSerialQueue
 */

/** A held serial slot; `release()` frees it (idempotent). */
export interface SerialSlot {
  release(): void;
}

/** Options for one `acquire`. */
export interface SerialAcquireOptions {
  /** Reject the waiter after this many ms (wire → 503). */
  waitTimeoutMs: number;
  /** Minimum gap (ms) since this key's last release before the next grant. */
  delayMs: number;
  /** Clock reference for the immediate-grant decision (default `Date.now()`). */
  now?: number;
}

/** A per-key snapshot entry (only keys with a held slot or non-empty queue). */
export interface SerialQueueStatusEntry {
  providerId: string;
  holding: boolean;
  waiting: number;
}

/** Rejection thrown when a serial waiter exceeds `waitTimeoutMs`. */
export class SerialQueueTimeoutError extends Error {
  readonly code = 'serial_queue_timeout';
  constructor(
    readonly providerId: string,
    readonly waitTimeoutMs: number,
  ) {
    super(`user-message serial queue wait timed out after ${waitTimeoutMs}ms for '${providerId}'`);
    this.name = 'SerialQueueTimeoutError';
  }
}

/** True for a rejection produced by the serial queue wait-timeout. */
export function isSerialQueueTimeout(err: unknown): err is SerialQueueTimeoutError {
  return err instanceof SerialQueueTimeoutError;
}

interface SerialWaiter {
  readonly delayMs: number;
  resolve(slot: SerialSlot): void;
  reject(err: Error): void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

interface SerialKeyState {
  /** The single logical slot is currently held. */
  holding: boolean;
  /** Timestamp of the most recent release (for the `delayMs` gap). */
  lastReleaseTs: number | null;
  /** FIFO waiters. */
  waiters: SerialWaiter[];
  /** A pending scheduled dispatch (residual `delayMs` gap), if any. */
  dispatchHandle: ReturnType<typeof setTimeout> | null;
}

/**
 * Per-`providerId` single-slot mutex + `delayMs` spacing gate with a FIFO wait
 * queue. `acquire` resolves when the key is free AND at least `delayMs` has
 * elapsed since that key's last release.
 */
export class UserMessageSerialQueue {
  private readonly states = new Map<string, SerialKeyState>();

  private ensure(providerId: string): SerialKeyState {
    let state = this.states.get(providerId);
    if (!state) {
      state = { holding: false, lastReleaseTs: null, waiters: [], dispatchHandle: null };
      this.states.set(providerId, state);
    }
    return state;
  }

  /**
   * Acquire the serial slot for `providerId`. Resolves immediately when the slot
   * is free, no one is queued, and the `delayMs` gap since the last release has
   * elapsed; otherwise enqueues FIFO and resolves in order (or rejects with a
   * {@link SerialQueueTimeoutError} after `waitTimeoutMs`).
   */
  acquire(providerId: string, options: SerialAcquireOptions): Promise<SerialSlot> {
    const { waitTimeoutMs, delayMs } = options;
    const now = options.now ?? Date.now();
    const state = this.ensure(providerId);

    const spacingElapsed =
      state.lastReleaseTs === null || now - state.lastReleaseTs >= delayMs;
    if (!state.holding && state.waiters.length === 0 && spacingElapsed) {
      state.holding = true;
      return Promise.resolve(this.makeSlot(providerId));
    }

    return new Promise<SerialSlot>((resolve, reject) => {
      const waiter: SerialWaiter = {
        delayMs,
        resolve,
        reject,
        timeoutHandle: null,
        done: false,
      };
      waiter.timeoutHandle = setTimeout(() => {
        if (waiter.done) return;
        waiter.done = true;
        const idx = state.waiters.indexOf(waiter);
        if (idx >= 0) state.waiters.splice(idx, 1);
        reject(new SerialQueueTimeoutError(providerId, waitTimeoutMs));
      }, waitTimeoutMs);
      state.waiters.push(waiter);
      this.maybeDispatch(providerId);
    });
  }

  /** Build an idempotent release for a granted slot. */
  private makeSlot(providerId: string): SerialSlot {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const state = this.states.get(providerId);
        if (!state) return;
        state.holding = false;
        state.lastReleaseTs = Date.now();
        this.maybeDispatch(providerId);
      },
    };
  }

  /**
   * Grant the head waiter when the slot is free and the head's `delayMs` gap has
   * elapsed; otherwise schedule a dispatch for the residual gap. No-op while the
   * slot is held (release re-invokes this) or the queue is empty.
   */
  private maybeDispatch(providerId: string): void {
    const state = this.states.get(providerId);
    if (!state || state.holding || state.waiters.length === 0) return;

    const head = state.waiters[0];
    const now = Date.now();
    const elapsed = state.lastReleaseTs === null ? Infinity : now - state.lastReleaseTs;
    const residual = Math.max(0, head.delayMs - elapsed);
    if (residual <= 0) {
      this.grantHead(providerId);
      return;
    }
    if (state.dispatchHandle !== null) return;
    state.dispatchHandle = setTimeout(() => {
      state.dispatchHandle = null;
      this.grantHead(providerId);
    }, residual);
  }

  /** Hand the slot to the FIFO head (if free and someone is waiting). */
  private grantHead(providerId: string): void {
    const state = this.states.get(providerId);
    if (!state || state.holding || state.waiters.length === 0) return;
    // Invalidate any scheduled dispatch — this grant supersedes it. Without
    // this, a direct (residual<=0) grant leaves a stale timer pending; under
    // event-loop lag past its deadline the next release would rely on that
    // stale timer and skip the fresh `delayMs` gap (mutual exclusion is never
    // at risk, but the spacing invariant would be bypassed for one request).
    if (state.dispatchHandle !== null) {
      clearTimeout(state.dispatchHandle);
      state.dispatchHandle = null;
    }
    const head = state.waiters.shift();
    if (!head) return;
    if (head.timeoutHandle) clearTimeout(head.timeoutHandle);
    head.done = true;
    state.holding = true;
    head.resolve(this.makeSlot(providerId));
  }

  /** Snapshot for observability — only keys holding a slot or with waiters. */
  getStatus(): SerialQueueStatusEntry[] {
    const out: SerialQueueStatusEntry[] = [];
    for (const [providerId, state] of this.states) {
      if (state.holding || state.waiters.length > 0) {
        out.push({ providerId, holding: state.holding, waiting: state.waiters.length });
      }
    }
    return out;
  }

  /** Drop all state + pending timers (tests / teardown). */
  reset(): void {
    for (const state of this.states.values()) {
      if (state.dispatchHandle) clearTimeout(state.dispatchHandle);
      for (const w of state.waiters) {
        if (w.timeoutHandle) clearTimeout(w.timeoutHandle);
      }
    }
    this.states.clear();
  }
}
