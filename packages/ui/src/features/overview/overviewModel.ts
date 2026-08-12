import type { AccountAllowanceSnapshot, AccountsListResponse, AllowanceWindowState, SubscriptionAccountSanitized } from '../../daemon/types-accounts';
import type {
  CliIntegrationStatusKind,
  CliIntegrationsOverview,
} from '../../daemon/types';
import type { AuditStats, GatewayBinding, OutboundApiKeyInfo, OutboundApiServerConfig, OutboundApiServerStatus } from '../../daemon/types-server';
import type { DashboardSummary } from '../../daemon/types-usage-pricing';

export type DataSourceState = 'loading' | 'ready' | 'unavailable';

/** A source is never coerced into a value when its read failed. */
export interface OverviewSource<T> {
  state: DataSourceState;
  data?: T;
  message?: string;
}

export type OverviewAuditData = AuditStats;

export type OverviewGatewayStatus = OutboundApiServerStatus & { version?: string };

export interface OverviewSources {
  gateway: {
    config: OverviewSource<OutboundApiServerConfig>;
    status: OverviewSource<OverviewGatewayStatus>;
    keys: OverviewSource<OutboundApiKeyInfo[]>;
    version: OverviewSource<string>;
  };
  accounts: OverviewSource<AccountsListResponse>;
  allowances: OverviewSource<AccountAllowanceSnapshot[]>;
  usage: OverviewSource<DashboardSummary>;
  integrations: OverviewSource<CliIntegrationsOverview>;
  audit: OverviewSource<OverviewAuditData>;
}

export type PathState = 'ready' | 'attention' | 'inactive' | 'loading' | 'unavailable';

export interface RequestPathStage {
  id: 'client' | 'gateway' | 'routing' | 'upstream';
  state: PathState;
  detail: string | null;
  detailState: DataSourceState;
}

export type OverviewRoute =
  | { page: 'api-service'; tab: 'overview' | 'access' }
  | { page: 'route-activity' }
  | { page: 'upstreams'; upstreamFilter?: 'account' }
  | { page: 'integrations' }
  | { page: 'usage-stats' }
  | { page: 'settings'; tab: 'data' | 'advanced' };

export type OverviewIssueId =
  | 'gatewayConfigUnavailable'
  | 'gatewayUnavailable'
  | 'gatewayStopped'
  | 'accessKeyDataUnavailable'
  | 'noAccessKey'
  | 'routingDataUnavailable'
  | 'routingIncomplete'
  | 'accountDataUnavailable'
  | 'noUpstream'
  | 'noSchedulableAccounts'
  | 'abnormalAccounts'
  | 'accountsExpiringSoon'
  | 'allowanceDataUnavailable'
  | 'allowanceNearLimit'
  | 'allowanceStale'
  | 'integrationDataUnavailable'
  | 'integrationCodexNeedsAttention'
  | 'integrationClaudeNeedsAttention'
  | 'usageDataUnavailable'
  | 'errorRateUnavailable';

export interface OverviewIssue {
  id: OverviewIssueId;
  route: OverviewRoute;
  severity: 'blocking' | 'warning';
  count?: number;
}

export interface OverviewMetric<T> {
  state: DataSourceState;
  value?: T;
}

export interface AllowanceWatchItem {
  providerId: string;
  accountId: string;
  label: string;
  usedPercent?: number;
  windowLabel?: string;
  resetsAt?: string;
  kind: 'near-limit' | 'stale';
}

export interface AllowanceWeeklyItem {
  providerId: string;
  accountId: string;
  label: string;
  usedPercent?: number;
  state: AllowanceWindowState;
  resetsAt?: string;
}

export interface OverviewModel {
  stages: RequestPathStage[];
  pathOperational: boolean;
  overallState: 'loading' | 'operational' | 'attention';
  issues: OverviewIssue[];
  /** Endpoints covered by an enabled downstream route (0–4). */
  routeCount: number;
  /** Distinct upstream resources those routes point at. */
  configuredTargetCount: number;
  gateway: {
    status: OverviewMetric<'running' | 'stopped'>;
    address: OverviewMetric<string>;
    port: OverviewMetric<number>;
    version: OverviewMetric<string>;
  };
  accounts: {
    total: OverviewMetric<number>;
    schedulable: OverviewMetric<number>;
    abnormal: OverviewMetric<number>;
    expiringSoon: OverviewMetric<number>;
  };
  allowance: {
    threshold: number;
    nearLimit: AllowanceWatchItem[];
    stale: AllowanceWatchItem[];
    unavailableCount: number;
    unobservedCount: number;
    sourceState: DataSourceState;
    weeklyTop: AllowanceWeeklyItem[];
  };
  today: {
    requests: OverviewMetric<number>;
    costUsd: OverviewMetric<number>;
    errorRate: OverviewMetric<number>;
    errorCount?: number;
    auditedRequestCount?: number;
    errorRateReason?: 'audit-disabled' | 'audit-unavailable' | 'audit-incomplete' | 'no-audited-requests';
  };
  integrations: Array<{
    client: 'codex' | 'claude';
    state: DataSourceState;
    status?: CliIntegrationStatusKind;
    gatewayBaseUrl?: string;
    needsAttention: boolean;
  }>;
}

const EXPIRING_SOON_MS = 48 * 60 * 60 * 1000;
const DEFAULT_ALLOWANCE_WARNING_PERCENT = 80;

function sourceState<T>(source: OverviewSource<T>): DataSourceState {
  return source.state;
}

function enabledBindings(config: OutboundApiServerConfig | undefined): GatewayBinding[] {
  return (config?.bindings ?? []).filter((binding) => binding.enabled);
}

/** How many of the four endpoints an enabled downstream route covers. */
function coveredEndpointCount(bindings: readonly GatewayBinding[]): number {
  return new Set(bindings.map((binding) => binding.endpoint)).size;
}

/** Distinct upstream resources the enabled routes point at. */
function boundTargetCount(bindings: readonly GatewayBinding[]): number {
  return new Set(
    bindings.map((binding) => {
      const target = binding.target;
      if (target.kind === 'account') return `account:${target.providerId}:${target.accountId}`;
      if (target.kind === 'account-group') return `group:${target.providerId}:${target.group}`;
      if (target.kind === 'account-pool') return `pool:${target.providerId}`;
      return `provider:${target.providerId}:${target.keyId ?? ''}`;
    }),
  ).size;
}

interface AccountEntry {
  providerId: string;
  account: SubscriptionAccountSanitized;
}

function accountEntries(accounts: AccountsListResponse): AccountEntry[] {
  return Object.entries(accounts.providerAccounts).flatMap(([providerId, providerAccounts]) =>
    providerAccounts.map((account) => ({ providerId, account })),
  );
}

function isSchedulable(account: SubscriptionAccountSanitized): boolean {
  return account.enabled
    && account.schedulable
    && (!account.health || account.health === 'healthy');
}

function isAbnormal(account: SubscriptionAccountSanitized): boolean {
  return account.status === 'unconfigured'
    || account.status === 'expired'
    || account.status === 'error'
    || Boolean(account.errorMessage)
    || Boolean(account.syncWarning)
    || Boolean(account.health && account.health !== 'healthy');
}

function isExpiringSoon(account: SubscriptionAccountSanitized, now: number): boolean {
  if (!account.expiresAt) return false;
  const expiresAt = Date.parse(account.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now && expiresAt <= now + EXPIRING_SOON_MS;
}

function allowanceKey(providerId: string, accountId: string): string {
  return `${providerId}\u0000${accountId}`;
}

function buildAllowanceWatch(
  source: OverviewSource<AccountAllowanceSnapshot[]>,
  threshold: number,
  accounts: AccountEntry[],
): { nearLimit: AllowanceWatchItem[]; stale: AllowanceWatchItem[]; unavailableCount: number; unobservedCount: number } {
  if (source.state !== 'ready' || !source.data) {
    return { nearLimit: [], stale: [], unavailableCount: 0, unobservedCount: 0 };
  }

  const nearLimit: AllowanceWatchItem[] = [];
  const stale: AllowanceWatchItem[] = [];
  const unavailableKeys = new Set<string>();
  const unobservedKeys = new Set<string>();

  for (const snapshot of source.data) {
    const key = allowanceKey(snapshot.providerId, snapshot.accountId);
    if (snapshot.lastErrorCode === 'codex_allowance_not_observed') {
      unobservedKeys.add(key);
      continue;
    }
    if (snapshot.windows.length === 0) {
      unavailableKeys.add(key);
      continue;
    }
    const staleWindow = snapshot.windows.find((window) => window.state === 'stale');
    if (staleWindow) {
      stale.push({
        providerId: snapshot.providerId,
        accountId: snapshot.accountId,
        label: staleWindow.label,
        usedPercent: staleWindow.usedPercent ?? undefined,
        windowLabel: staleWindow.label,
        resetsAt: staleWindow.resetsAt,
        kind: 'stale',
      });
    }
    const highestFresh = snapshot.windows
      .filter((window) => window.state === 'fresh' && typeof window.usedPercent === 'number')
      .sort((left, right) => (right.usedPercent ?? -1) - (left.usedPercent ?? -1))[0];
    if (highestFresh && (highestFresh.usedPercent ?? 0) >= threshold) {
      nearLimit.push({
        providerId: snapshot.providerId,
        accountId: snapshot.accountId,
        label: highestFresh.label,
        usedPercent: highestFresh.usedPercent ?? undefined,
        windowLabel: highestFresh.label,
        resetsAt: highestFresh.resetsAt,
        kind: 'near-limit',
      });
    }
    if (snapshot.windows.every((window) => window.state === 'unavailable' || window.state === 'unsupported')) {
      unavailableKeys.add(allowanceKey(snapshot.providerId, snapshot.accountId));
    }
  }

  const observedKeys = new Set(source.data.map((snapshot) => allowanceKey(snapshot.providerId, snapshot.accountId)));
  for (const entry of accounts) {
    if (entry.providerId !== 'claude' && entry.providerId !== 'codex') continue;
    const key = allowanceKey(entry.providerId, entry.account.id);
    if (!observedKeys.has(key)) {
      if (entry.providerId === 'codex') unobservedKeys.add(key);
      else unavailableKeys.add(key);
    }
  }

  return {
    nearLimit,
    stale,
    unavailableCount: unavailableKeys.size,
    unobservedCount: unobservedKeys.size,
  };
}

/** Up to `limit` accounts ranked by weekly (seven-day) allowance usage. */
function buildWeeklyTop(
  source: OverviewSource<AccountAllowanceSnapshot[]>,
  accounts: AccountEntry[],
  limit = 3,
): AllowanceWeeklyItem[] {
  if (source.state !== 'ready' || !source.data) return [];
  const labelFor = new Map(
    accounts.map((entry) => [allowanceKey(entry.providerId, entry.account.id), entry.account.label || entry.account.id]),
  );
  const items: AllowanceWeeklyItem[] = [];
  for (const snapshot of source.data) {
    const weekly = snapshot.windows.find((window) => window.id === 'seven-day' || window.windowMinutes === 10_080);
    if (!weekly) continue;
    const key = allowanceKey(snapshot.providerId, snapshot.accountId);
    items.push({
      providerId: snapshot.providerId,
      accountId: snapshot.accountId,
      label: labelFor.get(key) ?? snapshot.accountId,
      usedPercent: typeof weekly.usedPercent === 'number' ? Math.max(0, Math.min(100, weekly.usedPercent)) : undefined,
      state: weekly.state,
      resetsAt: weekly.resetsAt,
    });
  }
  items.sort((left, right) => (right.usedPercent ?? -1) - (left.usedPercent ?? -1));
  return items.slice(0, limit);
}

function metric<T>(source: OverviewSource<unknown>, value: T | undefined): OverviewMetric<T> {
  return { state: source.state, ...(source.state === 'ready' && value !== undefined ? { value } : {}) };
}

function issue(
  id: OverviewIssueId,
  route: OverviewRoute,
  severity: OverviewIssue['severity'],
  count?: number,
): OverviewIssue {
  return { id, route, severity, ...(count === undefined ? {} : { count }) };
}

function auditErrorRate(
  audit: OverviewSource<OverviewAuditData>,
  usage: OverviewSource<DashboardSummary>,
): Pick<OverviewModel['today'], 'errorRate' | 'errorCount' | 'auditedRequestCount' | 'errorRateReason'> {
  if (audit.state === 'loading') return { errorRate: { state: 'loading' } };
  if (audit.state !== 'ready' || !audit.data) {
    return {
      errorRate: { state: 'unavailable' },
      errorRateReason: audit.message === 'audit-disabled' ? 'audit-disabled' : 'audit-unavailable',
    };
  }
  if (!audit.data.complete) {
    return { errorRate: { state: 'unavailable' }, errorRateReason: 'audit-incomplete' };
  }

  const auditedRequestCount = audit.data.requestCount;
  const requestCount = usage.state === 'ready' ? usage.data?.today.eventCount ?? 0 : undefined;
  if (auditedRequestCount === 0 && requestCount !== 0) {
    return {
      errorRate: { state: 'unavailable' },
      auditedRequestCount,
      errorRateReason: 'no-audited-requests',
    };
  }

  const errorCount = audit.data.errorCount;
  return {
    errorRate: { state: 'ready', value: auditedRequestCount === 0 ? 0 : errorCount / auditedRequestCount },
    errorCount,
    auditedRequestCount,
  };
}

function integrationRows(source: OverviewSource<CliIntegrationsOverview>): OverviewModel['integrations'] {
  return (['codex', 'claude'] as const).map((client) => {
    if (source.state !== 'ready' || !source.data) return { client, state: source.state, needsAttention: false };
    const row = source.data.integrations.find((integration) => integration.client === client);
    if (!row) return { client, state: 'unavailable', needsAttention: false };
    const needsAttention = row.status === 'configuration-drift'
      || row.status === 'configuration-missing'
      || row.status === 'key-missing';
    return {
      client,
      state: 'ready',
      status: row.status,
      gatewayBaseUrl: row.gatewayBaseUrl,
      needsAttention,
    };
  });
}

export function buildOverviewModel(input: OverviewSources, now = Date.now()): OverviewModel {
  const config = input.gateway.config.data;
  const status = input.gateway.status.data;
  const keys = input.gateway.keys.data;
  const accounts = input.accounts.data;
  const routes = enabledBindings(config);
  const routeCount = coveredEndpointCount(routes);
  const configuredTargetCount = boundTargetCount(routes);
  const enabledKeyCount = keys?.filter((key) => key.enabled && !key.revoked).length;
  const entries = accounts ? accountEntries(accounts) : [];
  const rows = entries.map((entry) => entry.account);
  const schedulableCount = rows.filter(isSchedulable).length;
  const abnormalCount = rows.filter(isAbnormal).length;
  const expiringSoonCount = rows.filter((account) => isExpiringSoon(account, now)).length;
  const allowanceThreshold = config?.allowanceScheduling?.demoteAtPercent ?? DEFAULT_ALLOWANCE_WARNING_PERCENT;
  const allowanceWatch = buildAllowanceWatch(input.allowances, allowanceThreshold, entries);
  const weeklyTop = buildWeeklyTop(input.allowances, entries);
  const todayAudit = auditErrorRate(input.audit, input.usage);
  const integrations = integrationRows(input.integrations);

  const issues: OverviewIssue[] = [];
  if (input.gateway.config.state === 'unavailable') {
    issues.push(issue('gatewayConfigUnavailable', { page: 'api-service', tab: 'overview' }, 'warning'));
  }
  if (input.gateway.status.state === 'unavailable') {
    issues.push(issue('gatewayUnavailable', { page: 'api-service', tab: 'overview' }, 'blocking'));
  } else if (input.gateway.status.state === 'ready' && !status?.running) {
    issues.push(issue('gatewayStopped', { page: 'api-service', tab: 'overview' }, 'blocking'));
  }
  if (input.gateway.keys.state === 'unavailable') {
    issues.push(issue('accessKeyDataUnavailable', { page: 'api-service', tab: 'access' }, 'warning'));
  } else if (input.gateway.keys.state === 'ready' && enabledKeyCount === 0) {
    issues.push(issue('noAccessKey', { page: 'api-service', tab: 'access' }, 'blocking'));
  }
  if (input.gateway.config.state === 'unavailable') {
    // The config gap above already identifies the Gateway status destination;
    // do not turn the same missing read into a fabricated routing failure.
  } else if (input.gateway.config.state === 'ready' && routeCount === 0) {
    // A partially-covered gateway (1–3 of 4 wire formats) is intentionally not
    // flagged — most deployments only expose a subset of the formats. Only a
    // completely unrouted gateway blocks the request path.
    issues.push(issue('routingIncomplete', { page: 'upstreams' }, 'blocking'));
  }
  if (input.accounts.state === 'unavailable') {
    issues.push(issue('accountDataUnavailable', { page: 'upstreams', upstreamFilter: 'account' }, 'warning'));
  } else if (input.accounts.state === 'ready') {
    if (rows.length === 0 && configuredTargetCount === 0) {
      issues.push(issue('noUpstream', { page: 'upstreams', upstreamFilter: 'account' }, 'blocking'));
    } else if (rows.length > 0 && schedulableCount === 0 && configuredTargetCount === 0) {
      issues.push(issue('noSchedulableAccounts', { page: 'upstreams', upstreamFilter: 'account' }, 'blocking'));
    }
    if (abnormalCount > 0) issues.push(issue('abnormalAccounts', { page: 'upstreams', upstreamFilter: 'account' }, 'warning', abnormalCount));
    if (expiringSoonCount > 0) {
      issues.push(issue('accountsExpiringSoon', { page: 'upstreams', upstreamFilter: 'account' }, 'warning', expiringSoonCount));
    }
  }
  if (input.allowances.state === 'unavailable') {
    issues.push(issue('allowanceDataUnavailable', { page: 'upstreams', upstreamFilter: 'account' }, 'warning'));
  } else if (input.allowances.state === 'ready') {
    if (allowanceWatch.unavailableCount > 0) {
      issues.push(issue('allowanceDataUnavailable', { page: 'upstreams', upstreamFilter: 'account' }, 'warning', allowanceWatch.unavailableCount));
    }
    if (allowanceWatch.nearLimit.length > 0) {
      issues.push(issue('allowanceNearLimit', { page: 'upstreams', upstreamFilter: 'account' }, 'warning', allowanceWatch.nearLimit.length));
    }
    if (allowanceWatch.stale.length > 0) {
      issues.push(issue('allowanceStale', { page: 'upstreams', upstreamFilter: 'account' }, 'warning', allowanceWatch.stale.length));
    }
  }
  if (input.integrations.state === 'unavailable') {
    issues.push(issue('integrationDataUnavailable', { page: 'integrations' }, 'warning'));
  } else {
    for (const integration of integrations) {
      if (integration.needsAttention) {
        const id = integration.client === 'codex'
          ? 'integrationCodexNeedsAttention'
          : 'integrationClaudeNeedsAttention';
        issues.push(issue(id, { page: 'integrations' }, 'warning'));
      }
    }
  }
  if (input.usage.state === 'unavailable') {
    issues.push(issue('usageDataUnavailable', { page: 'usage-stats' }, 'warning'));
  }
  if (todayAudit.errorRate.state === 'unavailable' && input.usage.state !== 'loading') {
    const auditRoute = todayAudit.errorRateReason === 'audit-disabled'
      ? { page: 'settings', tab: 'data' } as const
      : { page: 'route-activity' } as const;
    issues.push(issue('errorRateUnavailable', auditRoute, 'warning'));
  }

  const sourceStates = [
    input.gateway.config.state,
    input.gateway.status.state,
    input.gateway.keys.state,
    input.accounts.state,
    input.allowances.state,
    input.usage.state,
    input.integrations.state,
    input.audit.state,
  ];
  const overallState = sourceStates.some((state) => state === 'loading')
    ? 'loading'
    : issues.length > 0 ? 'attention' : 'operational';

  const stages: RequestPathStage[] = [
    {
      id: 'client',
      state: input.gateway.keys.state === 'loading'
        ? 'loading'
        : input.gateway.keys.state === 'unavailable'
          ? 'unavailable'
          : enabledKeyCount && enabledKeyCount > 0 ? 'ready' : 'attention',
      detail: enabledKeyCount === undefined ? null : String(enabledKeyCount),
      detailState: sourceState(input.gateway.keys),
    },
    {
      id: 'gateway',
      state: input.gateway.status.state === 'loading' || input.gateway.config.state === 'loading'
        ? 'loading'
        : input.gateway.status.state === 'unavailable'
          ? 'unavailable'
          : status?.running
            ? 'ready'
            : config?.enabled ? 'attention' : 'inactive',
      detail: status?.running && status.port > 0 ? String(status.port) : status?.running ? null : 'off',
      detailState: input.gateway.status.state,
    },
    {
      id: 'routing',
      state: input.gateway.config.state === 'loading'
        ? 'loading'
        : input.gateway.config.state === 'unavailable'
          ? 'unavailable'
          : routeCount > 0 ? 'ready' : 'inactive',
      detail: input.gateway.config.state === 'ready' ? `${routeCount}/4` : null,
      detailState: input.gateway.config.state,
    },
    {
      id: 'upstream',
      state: input.accounts.state === 'loading' || input.gateway.config.state === 'loading'
        ? 'loading'
        : input.accounts.state === 'unavailable'
          ? 'unavailable'
          : schedulableCount > 0 || configuredTargetCount > 0 ? 'ready' : 'attention',
      detail: input.accounts.state === 'ready'
        ? `${schedulableCount}/${configuredTargetCount}`
        : null,
      detailState: input.accounts.state,
    },
  ];

  return {
    stages,
    pathOperational: stages.every((stage) => stage.state === 'ready'),
    overallState,
    issues,
    routeCount,
    configuredTargetCount,
    gateway: {
      status: input.gateway.status.state === 'ready' && status
        ? metric(input.gateway.status, status.running ? 'running' : 'stopped')
        : { state: input.gateway.status.state },
      address: input.gateway.status.state === 'ready' && status?.loopbackUrl
        ? { state: 'ready', value: status.loopbackUrl }
        : { state: input.gateway.status.state },
      port: input.gateway.status.state === 'ready' && status?.running && status.port > 0
        ? { state: 'ready', value: status.port }
        : { state: input.gateway.status.state },
      version: input.gateway.version.state === 'ready' && input.gateway.version.data
        ? { state: 'ready', value: input.gateway.version.data }
        : { state: input.gateway.version.state },
    },
    accounts: {
      total: metric(input.accounts, rows.length),
      schedulable: metric(input.accounts, schedulableCount),
      abnormal: metric(input.accounts, abnormalCount),
      expiringSoon: metric(input.accounts, expiringSoonCount),
    },
    allowance: {
      threshold: allowanceThreshold,
      ...allowanceWatch,
      sourceState: input.allowances.state,
      weeklyTop,
    },
    today: {
      requests: metric(input.usage, input.usage.data?.today.eventCount),
      costUsd: metric(input.usage, input.usage.data?.today.costUsd),
      ...todayAudit,
    },
    integrations,
  };
}

/** Small helpers kept public for focused model tests and the Overview view. */
export const overviewModelInternals = {
  coveredEndpointCount,
  boundTargetCount,
  allowanceKey,
};
