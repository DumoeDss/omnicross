/**
 * usagePricingAdapter.ts — typed functions over `adminClient` for the Usage
 * Stats and Pricing pages.
 *
 * ALL envelope unwrapping happens here so hooks/components see clean DTOs:
 * usage GETs are BARE DTOs; `GET /pricing` → `{ entries }`; `PUT /pricing` →
 * `{ entry }`; `DELETE /pricing` → `{ deleted }`. Query strings are built with
 * `URLSearchParams` — model ids may contain `/` and other reserved characters
 * (LiteLLM ids), so they are never string-concatenated into the path.
 */

import { adminClient } from './adminClient';

import type {
  AccountAllowanceCycle,
  ApiKeyUsageRow,
  DashboardSummary,
  ModelUsageRow,
  PricingConflictResolutionInput,
  PricingEntry,
  PricingEntryInput,
  PricingFetchLatestResult,
  PricingResolutionResult,
  UsageDateRange,
  UsageQueryFilter,
  UsageTimeBucket,
  UsageTimeSeriesBucket,
  UsageThroughputResult,
  UsageThroughputSnapshot,
  UsageTotals,
} from './types-usage-pricing';

/** Append the OPTIONAL attribute filter params (`providerId`/`apiKeyId`). */
function filterParams(qs: URLSearchParams, filter?: UsageQueryFilter): URLSearchParams {
  if (filter?.providerId) qs.set('providerId', filter.providerId);
  if (filter?.apiKeyId) qs.set('apiKeyId', filter.apiKeyId);
  return qs;
}

/** Build the `?startTs&endTs` (+ optional filter) query for the usage endpoints. */
function rangeQuery(range: UsageDateRange, filter?: UsageQueryFilter): string {
  const qs = new URLSearchParams({
    startTs: String(range.startTs),
    endTs: String(range.endTs),
  });
  filterParams(qs, filter);
  return `?${qs.toString()}`;
}

/** `GET /usage/totals` — bare `UsageTotals` (optional attribute filter). */
export function getUsageTotals(range: UsageDateRange, filter?: UsageQueryFilter): Promise<UsageTotals> {
  return adminClient.get<UsageTotals>(`/usage/totals${rangeQuery(range, filter)}`);
}

/** `GET /usage/by-model` — bare `ModelUsageRow[]` (optional attribute filter). */
export function getUsageByModel(range: UsageDateRange, filter?: UsageQueryFilter): Promise<ModelUsageRow[]> {
  return adminClient.get<ModelUsageRow[]>(`/usage/by-model${rangeQuery(range, filter)}`);
}

/** `GET /usage/by-api-key` — bare `ApiKeyUsageRow[]` (optional attribute filter). */
export function getUsageByApiKey(range: UsageDateRange, filter?: UsageQueryFilter): Promise<ApiKeyUsageRow[]> {
  return adminClient.get<ApiKeyUsageRow[]>(`/usage/by-api-key${rangeQuery(range, filter)}`);
}

/** `GET /usage/timeseries?startTs&endTs&bucket` — bare `UsageTimeSeriesBucket[]`. */
export function getUsageTimeSeries(
  range: UsageDateRange,
  bucket: UsageTimeBucket,
  filter?: UsageQueryFilter,
): Promise<UsageTimeSeriesBucket[]> {
  const qs = new URLSearchParams({
    startTs: String(range.startTs),
    endTs: String(range.endTs),
    bucket,
  });
  filterParams(qs, filter);
  return adminClient.get<UsageTimeSeriesBucket[]>(`/usage/timeseries?${qs.toString()}`);
}

/**
 * `GET /accounts/allowances/cycles?providerId&accountId` — billable-cycle
 * segments (observed boundary ledger merged with the live snapshot). A daemon
 * predating the endpoint 404s; the caller surfaces that as "no cycle history".
 */
export async function getAllowanceCycles(filter?: {
  providerId?: string;
  accountId?: string;
}): Promise<AccountAllowanceCycle[]> {
  const qs = new URLSearchParams();
  if (filter?.providerId) qs.set('providerId', filter.providerId);
  if (filter?.accountId) qs.set('accountId', filter.accountId);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const body = await adminClient.get<{ cycles: AccountAllowanceCycle[] }>(
    `/accounts/allowances/cycles${suffix}`,
  );
  return body.cycles;
}

/** `GET /dashboard` — bare `DashboardSummary`. */
export function getDashboardSummary(): Promise<DashboardSummary> {
  return adminClient.get<DashboardSummary>('/dashboard');
}

/**
 * `GET /usage/throughput` — bare `UsageThroughputSnapshot`. Takes NO range: the
 * daemon answers from an in-memory sliding window.
 *
 * A daemon predating the endpoint 404s, so the failure is degraded into
 * `available: false` (same shape as `queryOverloadCounters`) rather than thrown:
 * "this daemon cannot report a rate" must never be rendered as a rate of zero.
 */
export async function getUsageThroughput(): Promise<UsageThroughputResult> {
  try {
    const snapshot = await adminClient.get<UsageThroughputSnapshot>('/usage/throughput');
    if (!snapshot || snapshot.available !== true || !Array.isArray(snapshot.windows)) {
      return { available: false, collectedAt: Date.now() };
    }
    return snapshot;
  } catch {
    return { available: false, collectedAt: Date.now() };
  }
}

/** `GET /pricing` — unwraps the `{ entries }` envelope. */
export async function getPricing(): Promise<PricingEntry[]> {
  const data = await adminClient.get<{ entries: PricingEntry[] }>('/pricing');
  return data.entries;
}

/** `PUT /pricing` — unwraps the `{ entry }` envelope. */
export async function upsertPricing(input: PricingEntryInput): Promise<PricingEntry> {
  const data = await adminClient.put<{ entry: PricingEntry }>('/pricing', input);
  return data.entry;
}

/** `DELETE /pricing?providerId&modelId` — ids URL-encoded via URLSearchParams. */
export async function deletePricing(providerId: string, modelId: string): Promise<boolean> {
  const qs = new URLSearchParams({ providerId, modelId });
  const data = await adminClient.delete<{ deleted: boolean }>(`/pricing?${qs.toString()}`);
  return data.deleted;
}

/** `POST /pricing/fetch-latest` — includes per-source LiteLLM/OpenRouter outcomes. */
export function fetchLatestPricing(): Promise<PricingFetchLatestResult> {
  return adminClient.post<PricingFetchLatestResult>('/pricing/fetch-latest');
}

/** `POST /pricing/resolve-conflicts` — stateless echo body. */
export function resolvePricingConflicts(
  resolutions: PricingConflictResolutionInput[],
): Promise<PricingResolutionResult> {
  return adminClient.post<PricingResolutionResult>('/pricing/resolve-conflicts', { resolutions });
}
