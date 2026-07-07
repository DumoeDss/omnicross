/**
 * keyedMutex — a tiny per-key async mutex (voucher-redemption #9, MJ1 fix).
 *
 * Serializes async critical sections that share a key so they run
 * one-after-another (each observing the previous one's committed effects),
 * mirroring the subscription `RefreshMutex` "one in-flight op per key" pattern.
 * Different keys never block each other.
 *
 * Used by the voucher redeem path to serialize a key's redemptions: two redeems
 * for the SAME key run sequentially, so each reads the other's applied result and
 * a RELATIVE grant increment accumulates instead of clobbering a shared snapshot.
 *
 * @module outbound-api/keyedMutex
 */

/** A per-key FIFO async mutex. In-memory; process-local. */
export class KeyedMutex {
  /** key → the tail of the pending-op chain (resolves when the last op frees). */
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Run `fn` exclusively for `key`: it starts only after every previously
   * enqueued op for the SAME key has settled, and the next waiter starts only
   * after `fn` settles. Returns `fn`'s result (or rejection). Never lets one op's
   * failure wedge the queue (waiters proceed regardless).
   */
  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Our turn ends when `gate` resolves; the next op chains off it.
    const chain = prev.then(() => gate);
    this.tails.set(key, chain);
    // Wait for all prior ops to finish (swallow their errors — a failed prior op
    // must not reject our turn).
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      // GC: if no one queued behind us, drop the key so the map stays bounded.
      if (this.tails.get(key) === chain) this.tails.delete(key);
    }
  }
}
