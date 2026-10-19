/**
 * usageStoreApi — the AUTHED admin surface for the sharded usage store:
 *
 *   GET  /admin/api/usage-store         current retention + on-disk footprint
 *   PUT  /admin/api/usage-store         persist `usage.retentionDays`
 *   POST /admin/api/usage-store/prune   run one retention pass NOW
 *
 * Lives in its own helper module (the #4/#8/#10 convention) so `adminApi.ts` —
 * at its line cap — is not touched: `AdminServer.dispatch` routes these paths
 * here directly, AFTER its auth gate.
 *
 * Secret-free by construction: sizes, day keys and a day count only — never an
 * event row, never a provider key. Both mutations are bounded by the configured
 * window: prune can never delete a day retention does not already consider
 * expired, and rollups are never touched (lifetime aggregates survive).
 *
 * @module @omnicross/daemon/admin/usageStoreApi
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { UsageStoreStats } from '../usage/usageStoreStats';

import { readJsonBody, writeJson, writeJsonError } from './adminApi';

/** What the Settings card renders. */
export interface UsageStoreInfo {
  /** Live retention window; `0` ⇒ keep everything. */
  retentionDays: number;
  stats: UsageStoreStats;
}

/** Outcome of the manual pass. */
export interface UsagePruneResultWire {
  removedDays: number;
  freedBytes: number;
}

/** The port the AdminServer consumes; bootstrap binds it to the live sweeper. */
export interface UsageStoreAdmin {
  getInfo(): Promise<UsageStoreInfo>;
  /** Persist + hot-apply a new window, returning the refreshed info. */
  setRetentionDays(days: number): Promise<UsageStoreInfo>;
  pruneNow(): Promise<UsagePruneResultWire>;
}

/** Upper bound for the window — a decade; anything larger is a typo, not intent. */
const MAX_RETENTION_DAYS = 3650;

export async function handleUsageStoreGet(
  res: ServerResponse,
  admin: UsageStoreAdmin | undefined,
): Promise<void> {
  if (!admin) return writeJsonError(res, 501, 'usage store admin is not wired');
  try {
    writeJson(res, 200, await admin.getInfo());
  } catch (error) {
    writeJsonError(res, 500, error instanceof Error ? error.message : 'failed to read usage store');
  }
}

/**
 * Persist the retention window. A present `retentionDays` must be a finite
 * number in `[0, 3650]`; `0` means "keep everything" (the sweeper disarms).
 * Strict — an illegal value is a 400, never a silent clamp.
 */
export async function handleUsageStorePut(
  req: IncomingMessage,
  res: ServerResponse,
  admin: UsageStoreAdmin | undefined,
): Promise<void> {
  if (!admin) return writeJsonError(res, 501, 'usage store admin is not wired');
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    return writeJsonError(res, 400, 'invalid JSON body');
  }
  const value = body['retentionDays'];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return writeJsonError(res, 400, 'retentionDays must be a number');
  }
  const days = Math.trunc(value);
  if (days < 0 || days > MAX_RETENTION_DAYS) {
    return writeJsonError(res, 400, `retentionDays must be 0..${MAX_RETENTION_DAYS}`);
  }
  try {
    writeJson(res, 200, await admin.setRetentionDays(days));
  } catch (error) {
    writeJsonError(res, 500, error instanceof Error ? error.message : 'failed to save usage retention');
  }
}

/** Run one retention pass now; reports days retired + bytes reclaimed. */
export async function handleUsageStorePrune(
  res: ServerResponse,
  admin: UsageStoreAdmin | undefined,
): Promise<void> {
  if (!admin) return writeJsonError(res, 501, 'usage store admin is not wired');
  try {
    writeJson(res, 200, await admin.pruneNow());
  } catch (error) {
    writeJsonError(res, 500, error instanceof Error ? error.message : 'usage prune failed');
  }
}
