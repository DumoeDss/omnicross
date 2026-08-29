import { adminClient, DAEMON_BASE_URL } from '../../daemon/adminClient';
import { daemonFetch } from '../../daemon/httpFetch';

import type {
  AccountsListResponse,
  AccountAllowanceSnapshot,
  SubscriptionAccountSanitized,
  SubscriptionProviderId,
} from '../../daemon/types-accounts';
import type {
  AuditStats,
  OutboundApiKeyInfo,
  OutboundApiServerConfig,
} from '../../daemon/types-server';
import type { DashboardSummary } from '../../daemon/types-usage-pricing';
import type {
  OverviewAuditData,
  OverviewGatewayStatus,
  OverviewSource,
  OverviewSources,
} from './overviewModel';
import type { CliIntegrationsOverview } from '../../daemon/types';

/** Keep a cold start finite even when one optional admin endpoint hangs. */
export const OVERVIEW_SOURCE_TIMEOUT_MS = 6_000;
const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProviderId[] = [
  'claude',
  'codex',
  'gemini',
  'opencodego',
];

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'source unavailable';
}

function unavailable<T>(message: string): OverviewSource<T> {
  return { state: 'unavailable', message };
}

/** Convert one independent read into an honest source state. */
export function readOverviewSource<T>(
  reader: () => Promise<T>,
  timeoutMs = OVERVIEW_SOURCE_TIMEOUT_MS,
): Promise<OverviewSource<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: OverviewSource<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(value);
    };
    const timeoutId = setTimeout(
      () => finish(unavailable<T>('source timed out')),
      timeoutMs,
    );
    void Promise.resolve().then(reader).then(
      (data) => finish({ state: 'ready', data }),
      (error) => finish(unavailable<T>(errorMessage(error))),
    );
  });
}

function localDayStart(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

async function readGatewayConfig(): Promise<OutboundApiServerConfig> {
  const body = await adminClient.get<{ server?: OutboundApiServerConfig }>('/server');
  if (!body.server) throw new Error('Gateway configuration was empty');
  return body.server;
}

async function readGatewayKeys(): Promise<OutboundApiKeyInfo[]> {
  const body = await adminClient.get<{ keys?: OutboundApiKeyInfo[] }>('/keys');
  if (!Array.isArray(body.keys)) throw new Error('Gateway access-key data was empty');
  return body.keys;
}

async function readGatewayStatus(): Promise<OverviewGatewayStatus> {
  const body = await adminClient.get<unknown>('/status');
  if (!body || typeof body !== 'object') throw new Error('Gateway status was empty');
  const status = body as Partial<OverviewGatewayStatus>;
  if (typeof status.running !== 'boolean' || typeof status.port !== 'number') {
    throw new Error('Gateway status was incomplete');
  }
  return body as OverviewGatewayStatus;
}

async function readGatewayVersion(): Promise<string> {
  // `/health` is intentionally unauthenticated and is served by the daemon's
  // admin listener in both the desktop shell and the hosted Control Panel.
  const response = await daemonFetch(`${DAEMON_BASE_URL}/health`, { method: 'GET' });
  if (!response.ok) throw new Error(`health probe failed (${response.status})`);
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== 'string' || body.version.trim() === '') {
    throw new Error('daemon version was not exposed');
  }
  return body.version;
}

/** Normalize the daemon's sparse provider projection into the UI's complete map. */
export function normalizeOverviewAccounts(body: unknown): AccountsListResponse {
  if (!body || typeof body !== 'object') throw new Error('Account data was empty');
  const raw = body as Partial<AccountsListResponse>;
  if (!raw.providerAccounts || typeof raw.providerAccounts !== 'object') {
    throw new Error('Account data was incomplete');
  }
  const sparse = raw.providerAccounts as Partial<
    Record<SubscriptionProviderId, SubscriptionAccountSanitized[]>
  >;
  const providerAccounts = Object.fromEntries(
    SUBSCRIPTION_PROVIDERS.map((provider) => [
      provider,
      Array.isArray(sparse[provider]) ? sparse[provider] : [],
    ]),
  ) as Record<SubscriptionProviderId, SubscriptionAccountSanitized[]>;
  return {
    ...raw,
    accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
    providerAccounts,
  };
}

async function readAccounts(): Promise<AccountsListResponse> {
  return normalizeOverviewAccounts(await adminClient.get<unknown>('/accounts'));
}

async function readAllowances(): Promise<AccountAllowanceSnapshot[]> {
  const body = await adminClient.get<{ allowances?: AccountAllowanceSnapshot[] }>('/accounts/allowances');
  if (!Array.isArray(body.allowances)) throw new Error('Account allowance data was empty');
  return body.allowances;
}

/** Refresh the independently polled account-allowance source. */
export function loadOverviewAllowances(): Promise<OverviewSource<AccountAllowanceSnapshot[]>> {
  return readOverviewSource(readAllowances);
}

async function readIntegrations(): Promise<CliIntegrationsOverview> {
  const body = await adminClient.get<unknown>('/integrations');
  if (!body || typeof body !== 'object' || !Array.isArray((body as Partial<CliIntegrationsOverview>).integrations)) {
    throw new Error('Persistent integration data was empty');
  }
  return body as CliIntegrationsOverview;
}

async function readAudit(now: number): Promise<OverviewAuditData> {
  const query = new URLSearchParams({
    from: String(localDayStart(now)),
    to: String(now),
  });
  const body = await adminClient.get<Partial<AuditStats>>(`/audit/stats?${query.toString()}`);
  if (
    typeof body.requestCount !== 'number' ||
    typeof body.errorCount !== 'number' ||
    typeof body.complete !== 'boolean'
  ) {
    throw new Error('Request audit stats were empty');
  }
  return body as AuditStats;
}

async function readUsage(): Promise<DashboardSummary> {
  const body = await adminClient.get<unknown>('/dashboard');
  if (!body || typeof body !== 'object') throw new Error('Usage dashboard was empty');
  const dashboard = body as DashboardSummary;
  if (!dashboard.today || typeof dashboard.today.eventCount !== 'number' || typeof dashboard.today.costUsd !== 'number') {
    throw new Error('Usage dashboard was incomplete');
  }
  return dashboard;
}

/**
 * Read each Overview concern separately. One rejected source becomes an
 * unavailable row; it cannot erase the other evidence on the page.
 */
export async function loadOverviewSources(now = Date.now()): Promise<OverviewSources> {
  const [config, status, keys, version, accounts, allowances, usage, integrations, audit] = await Promise.all([
    readOverviewSource(readGatewayConfig),
    readOverviewSource(readGatewayStatus),
    readOverviewSource(readGatewayKeys),
    readOverviewSource(readGatewayVersion),
    readOverviewSource(readAccounts),
    loadOverviewAllowances(),
    readOverviewSource(readUsage),
    readOverviewSource(readIntegrations),
    readOverviewSource(() => readAudit(now)),
  ]);

  // Audit is useful only when the persisted Gateway config confirms that its
  // capture is enabled. A successful empty response from an older/disabled
  // daemon must not be presented as a measured zero-error rate.
  const normalizedAudit = config.state === 'ready'
    ? config.data?.audit?.enabled
      ? audit
      : unavailable<OverviewAuditData>('audit-disabled')
    : unavailable<OverviewAuditData>('gateway-config-unavailable');

  return {
    gateway: { config, status, keys, version },
    accounts,
    allowances,
    usage,
    integrations,
    audit: normalizedAudit,
  };
}
