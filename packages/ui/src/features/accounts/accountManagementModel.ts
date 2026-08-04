import type {
  AccountAllowanceSnapshot,
  AccountsListResponse,
  SubscriptionAccountSanitized,
  SubscriptionProviderId,
} from '@/daemon/types';

export interface ManagedAccountRow extends SubscriptionAccountSanitized {
  providerId: SubscriptionProviderId;
  allowance?: AccountAllowanceSnapshot;
}

export type AccountSchedulingState =
  | 'disabled'
  | 'healthPaused'
  | 'allowancePaused'
  | 'demoted'
  | 'schedulable'
  | 'excluded';

/** Mirrors the runtime gate order so the account list explains why a row is out. */
export function accountSchedulingState(row: ManagedAccountRow): AccountSchedulingState {
  if (!row.enabled) return 'disabled';
  if ((row.health ?? 'healthy') !== 'healthy') return 'healthPaused';
  if (row.allowanceAction === 'pause') return 'allowancePaused';
  if (row.allowanceAction === 'demote') return 'demoted';
  return row.schedulable ? 'schedulable' : 'excluded';
}

export type AccountSort = 'label' | 'priority' | 'last-used' | 'allowance' | 'reset-time';

export interface AccountFilters {
  query: string;
  provider: SubscriptionProviderId | 'all';
  group: string;
  health: 'all' | NonNullable<SubscriptionAccountSanitized['health']>;
  credential: 'all' | SubscriptionAccountSanitized['status'];
  scheduling: 'all' | 'enabled' | 'disabled' | 'schedulable' | 'excluded';
  sort: AccountSort;
  direction: 'asc' | 'desc';
}

export const DEFAULT_ACCOUNT_FILTERS: AccountFilters = {
  query: '',
  provider: 'all',
  group: 'all',
  health: 'all',
  credential: 'all',
  scheduling: 'all',
  sort: 'priority',
  direction: 'asc',
};

const allowanceKey = (providerId: string, accountId: string) => `${providerId}\0${accountId}`;

export function flattenAccounts(
  data: AccountsListResponse,
  allowances: AccountAllowanceSnapshot[],
): ManagedAccountRow[] {
  const allowanceIndex = new Map(
    allowances.map((snapshot) => [allowanceKey(snapshot.providerId, snapshot.accountId), snapshot]),
  );
  const rows: ManagedAccountRow[] = [];
  for (const providerId of ['claude', 'codex', 'gemini', 'opencodego'] as const) {
    for (const account of data.providerAccounts[providerId] ?? []) {
      rows.push({
        ...account,
        providerId,
        enabled: account.enabled !== false,
        schedulable: account.schedulable ?? account.enabled !== false,
        group: account.group || providerId,
        tags: account.tags ?? [],
        allowance: allowanceIndex.get(allowanceKey(providerId, account.id)),
      });
    }
  }
  return rows;
}

function allowanceUsed(row: ManagedAccountRow): number {
  const values = row.allowance?.windows
    .map((window) => window.usedPercent)
    .filter((value): value is number => typeof value === 'number') ?? [];
  return values.length ? Math.max(...values) : -1;
}

function resetTime(row: ManagedAccountRow): number {
  const values = row.allowance?.windows
    .map((window) => window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN)
    .filter(Number.isFinite) ?? [];
  return values.length ? Math.min(...values) : Number.POSITIVE_INFINITY;
}

function compareRows(a: ManagedAccountRow, b: ManagedAccountRow, sort: AccountSort): number {
  switch (sort) {
    case 'label':
      return (a.label || a.id).localeCompare(b.label || b.id);
    case 'priority':
      return (a.allowanceEffectivePriority ?? a.priority ?? 50) -
        (b.allowanceEffectivePriority ?? b.priority ?? 50);
    case 'last-used':
      return (a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0) - (b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0);
    case 'allowance':
      return allowanceUsed(a) - allowanceUsed(b);
    case 'reset-time':
      return resetTime(a) - resetTime(b);
  }
}

export function filterAndSortAccounts(rows: ManagedAccountRow[], filters: AccountFilters): ManagedAccountRow[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return rows
    .filter((row) => filters.provider === 'all' || row.providerId === filters.provider)
    .filter((row) => filters.group === 'all' || row.group === filters.group)
    .filter((row) => filters.health === 'all' || (row.health ?? 'healthy') === filters.health)
    .filter((row) => filters.credential === 'all' || row.status === filters.credential)
    .filter((row) => {
      if (filters.scheduling === 'all') return true;
      if (filters.scheduling === 'enabled') return row.enabled;
      if (filters.scheduling === 'disabled') return !row.enabled;
      if (filters.scheduling === 'schedulable') return row.schedulable;
      return !row.schedulable;
    })
    .filter((row) => !query || [row.label, row.id, row.group, ...row.tags]
      .some((value) => value?.toLocaleLowerCase().includes(query)))
    .sort((a, b) => {
      const compared = compareRows(a, b, filters.sort);
      const directed = filters.direction === 'asc' ? compared : -compared;
      return directed || a.providerId.localeCompare(b.providerId) || a.id.localeCompare(b.id);
    });
}

export function summarizeAccounts(rows: ManagedAccountRow[]) {
  return {
    total: rows.length,
    schedulable: rows.filter((row) => row.schedulable).length,
    excluded: rows.filter((row) => !row.schedulable).length,
    warnings: rows.filter((row) => row.syncWarning || row.status === 'error' || row.status === 'expired').length,
  };
}
