/**
 * autoDisableStore.ts — the daemon's PROCESS-IN-MEMORY auto-disable store.
 *
 * A DB-backed embedder can persist 401/403 auto-disable durably so a UI can
 * render per-key health. The daemon has no DB, and its only
 * durable layer is `config.json` — but writing auto-disable back there in v1
 * would (1) cause write amplification under a 401 storm and (2) collide with
 * the at-rest encryption schema that owns the `apiKeys[]` on-disk
 * format. So v1 records auto-disable IN MEMORY only:
 *  - `markAutoDisabled(keyId, status, at)` records `{ status, at, reason }`,
 *  - `isDisabled(keyId)` / `get(keyId)` read it back,
 *  - `loadPoolKeys` reads this store and flips a flagged key's `enabled` to
 *    `false`, so `getAvailableKeys` skips it within this process lifetime.
 *
 * Restart resets the store (the honest v1 boundary — see spec). Persistence
 * (encrypted write-back) is a child-3 follow-up.
 *
 * @module @omnicross/daemon/pool/autoDisableStore
 */

/** One in-memory auto-disable record for a pool key. */
export interface AutoDisableRecord {
  /** The HTTP status that triggered the disable (401/403). */
  status: number;
  /** Epoch-ms when the disable was recorded. */
  at: number;
  /** Always `'auth_failure'` in v1 (the only auto-disable trigger). */
  reason: 'auth_failure';
}

/**
 * A process-lifetime in-memory store of auto-disabled pool keys, keyed by the
 * pool key id. Constructed once in `buildDaemon` and injected as the pool's
 * `disableKey` / `markAutoDisabled` sinks AND read by `loadPoolKeys`.
 */
export class AutoDisableStore {
  private readonly records = new Map<string, AutoDisableRecord>();

  /** Record (or overwrite) an auth-failure auto-disable for `keyId`. */
  markAutoDisabled(keyId: string, status: number, at: number): void {
    this.records.set(keyId, { status, at, reason: 'auth_failure' });
  }

  /** Whether `keyId` is currently auto-disabled in this process. */
  isDisabled(keyId: string): boolean {
    return this.records.has(keyId);
  }

  /** Read the auto-disable record for `keyId`, or `undefined` when healthy. */
  get(keyId: string): AutoDisableRecord | undefined {
    return this.records.get(keyId);
  }

  /** Clear all records (tests / teardown). */
  clear(): void {
    this.records.clear();
  }
}
