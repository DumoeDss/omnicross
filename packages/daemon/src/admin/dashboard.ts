/**
 * dashboard — the admin overview summary surface (`GET /admin/api/dashboard`).
 *
 * A single read-only aggregate the Control Panel's landing view renders: today's
 * + all-time usage totals, provider/outbound-key/subscription-account counts, and
 * the outbound server's live status + this daemon's uptime. Pure handler returning
 * `{ status, body }`; the HTTP plumbing stays in `adminApi.ts` (the `usagePricing`
 * pattern).
 *
 * SECRET DISCIPLINE (IN-never-OUT): every field is a COUNT, boolean, port, or
 * timestamp derived from the config catalog / key store / account lister / server
 * status. No key material, token, or hash is read — so no `GET /dashboard` can
 * leak one (asserted by construction + the secret-scan test).
 *
 * @module @omnicross/daemon/admin/dashboard
 */

import type { UsageTotals } from '@omnicross/contracts/usage-stats-types';
import type { OutboundApiServer, OutboundKeyDb } from '@omnicross/core/outbound-api';
import type { UsageRecorder } from '@omnicross/core/usage';

import { loadConfig } from '../config';

/** The `GET /admin/api/dashboard` aggregate (BARE object; frozen shape). */
export interface DashboardSummary {
  /** Usage totals for local-midnight → now. */
  today: UsageTotals;
  /** Usage totals across the full retained range (startTs 0 → now). */
  total: UsageTotals;
  /** Provider catalog counts (`enabled` = `p.enabled !== false`). */
  providers: { total: number; enabled: number };
  /** Named outbound-key counts (`active` = `enabled && revokedAt === null`). */
  outboundKeys: { total: number; active: number };
  /** Subscription-account counts (total + a guarded per-provider breakdown). */
  accounts: { total: number; byProvider: Record<string, number> };
  /** Live outbound server status + this daemon process's uptime. */
  server: { running: boolean; port: number; uptimeMs: number };
  /** Unix-millis the summary was generated (`now`). */
  generatedAt: number;
}

/**
 * A focused structural subset of `AdminApiDeps` — only the read paths the summary
 * needs. `Pick`ed to the exact methods so the handler carries no more authority
 * than a counts-only read (never a secret-returning method).
 */
export interface DashboardDeps {
  /** Path to `config.json` — read for the provider catalog counts. */
  readonly configPath: string;
  /** Usage query facade (totals only). */
  readonly usageRecorder: Pick<UsageRecorder, 'getTotals'>;
  /** Named outbound-key store (list only). */
  readonly keyDb: Pick<OutboundKeyDb, 'outboundApiKeysList'>;
  /** Token-free subscription account lister. */
  readonly subscriptionAccounts: { listAll(): Promise<unknown[]> };
  /** Running outbound server (status only). */
  readonly outboundApiServer: Pick<OutboundApiServer, 'getStatus'>;
}

/** Local-midnight (00:00 in the daemon's timezone) for `ts`, DST-safe via `Date`. */
function startOfLocalDayMs(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Read a subscription account entry's provider id (grounds the concrete
 * `SubscriptionListEntry.providerId`; falls back to `provider`). Entries without
 * a string provider id only contribute to `accounts.total`, never `byProvider`.
 */
function accountProviderId(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  if (typeof e['providerId'] === 'string' && e['providerId']) return e['providerId'];
  if (typeof e['provider'] === 'string' && e['provider']) return e['provider'];
  return null;
}

/** `GET /admin/api/dashboard` → the `DashboardSummary` aggregate. */
export async function handleDashboard(
  deps: DashboardDeps,
): Promise<{ status: number; body: unknown }> {
  const now = Date.now();

  const today = await deps.usageRecorder.getTotals({ startTs: startOfLocalDayMs(now), endTs: now });
  const total = await deps.usageRecorder.getTotals({ startTs: 0, endTs: now });

  const providerList = loadConfig(deps.configPath).providers;
  const providers = {
    total: providerList.length,
    enabled: providerList.filter((p) => p.enabled !== false).length,
  };

  const keys = await deps.keyDb.outboundApiKeysList();
  const outboundKeys = {
    total: keys.length,
    active: keys.filter((k) => k.enabled && k.revokedAt === null).length,
  };

  const accountsList = await deps.subscriptionAccounts.listAll();
  const byProvider: Record<string, number> = {};
  for (const entry of accountsList) {
    const providerId = accountProviderId(entry);
    if (providerId) byProvider[providerId] = (byProvider[providerId] ?? 0) + 1;
  }
  const accounts = { total: accountsList.length, byProvider };

  const status = deps.outboundApiServer.getStatus();
  const server = {
    running: status.running,
    port: status.port,
    uptimeMs: Math.round(process.uptime() * 1000),
  };

  const summary: DashboardSummary = { today, total, providers, outboundKeys, accounts, server, generatedAt: now };
  return { status: 200, body: summary };
}
