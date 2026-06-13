/**
 * RefreshMutex — per-key promise dedup for OAuth token refresh.
 *
 * The dispatch proxy fires many parallel sub-requests (main model + background
 * task model + SDK probes). When all of them see 401 at once, every strategy
 * instance would independently call the credential store's `refresh*Token()`. The
 * second+ refresh races against the first one's STORE write and risks
 * clobbering with stale tokens. The mutex collapses concurrent refreshes for
 * the same key into a single in-flight promise that everyone awaits.
 */

export class RefreshMutex<TResult> {
  private inflight = new Map<string, Promise<TResult>>();

  /**
   * Run `task()` exclusively for `key`. If another caller is already running
   * for the same key, this call awaits the existing promise instead of
   * starting a new one — both get the SAME result.
   */
  async run(key: string, task: () => Promise<TResult>): Promise<TResult> {
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        return await task();
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }
}
