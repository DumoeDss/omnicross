import type {
  AccountAllowanceSnapshot,
  AccountConnectionTestResult,
  SubscriptionProviderId,
} from '@/daemon/types';

export interface AllowanceRefreshResult {
  success: boolean;
  message?: string;
}

export type AllowanceIndex = Record<string, AccountAllowanceSnapshot>;

export function allowanceKey(providerId: SubscriptionProviderId, accountId: string): string {
  return `${providerId}\u0000${accountId}`;
}

/** Index snapshots by both provider and managed account id to avoid cross-provider collisions. */
export function indexAllowances(snapshots: AccountAllowanceSnapshot[]): AllowanceIndex {
  const indexed: AllowanceIndex = {};
  for (const snapshot of snapshots) {
    if (!snapshot.accountId) continue;
    indexed[allowanceKey(snapshot.providerId, snapshot.accountId)] = snapshot;
  }
  return indexed;
}

/**
 * Merge only returned account snapshots. A failed/partial per-account refresh can therefore
 * preserve every unrelated row instead of replacing the full allowance collection.
 */
export function mergeAllowances(
  current: AccountAllowanceSnapshot[],
  updates: AccountAllowanceSnapshot[],
): AccountAllowanceSnapshot[] {
  const merged = indexAllowances(current);
  for (const update of updates) {
    if (!update.accountId) continue;
    merged[allowanceKey(update.providerId, update.accountId)] = update;
  }
  return Object.values(merged).sort(
    (left, right) =>
      left.providerId.localeCompare(right.providerId) || left.accountId.localeCompare(right.accountId),
  );
}

export function allowanceState(snapshot: AccountAllowanceSnapshot): 'fresh' | 'stale' | 'unavailable' | 'unsupported' {
  if (snapshot.windows.length === 0) return 'unavailable';
  if (snapshot.windows.some((window) => window.state === 'fresh')) return 'fresh';
  if (snapshot.windows.some((window) => window.state === 'stale')) return 'stale';
  if (snapshot.windows.every((window) => window.state === 'unsupported')) return 'unsupported';
  return 'unavailable';
}

/**
 * A Codex allowance refresh is an explicit, quota-consuming Luna probe followed
 * by a passive-cache reload. Reload even after a failed probe because an
 * upstream error response can still carry useful allowance headers.
 */
export async function probeAndReloadCodexAllowance(
  probe: () => Promise<AccountConnectionTestResult>,
  reload: () => Promise<AllowanceRefreshResult>,
): Promise<AllowanceRefreshResult> {
  const probeResult = await probe();
  const reloadResult = await reload();
  if (!probeResult.success || !probeResult.ok) {
    return {
      success: false,
      message: probeResult.message ?? 'Codex Luna allowance probe failed',
    };
  }
  return reloadResult;
}
