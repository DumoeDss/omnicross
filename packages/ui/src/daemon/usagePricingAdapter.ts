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
  ApiKeyUsageRow,
  ModelUsageRow,
  PricingConflictResolutionInput,
  PricingEntry,
  PricingEntryInput,
  PricingFetchLatestResult,
  PricingResolutionResult,
  UsageDateRange,
  UsageTotals,
} from './types-usage-pricing';

/** Build the `?startTs&endTs` query for the usage endpoints. */
function rangeQuery(range: UsageDateRange): string {
  const qs = new URLSearchParams({
    startTs: String(range.startTs),
    endTs: String(range.endTs),
  });
  return `?${qs.toString()}`;
}

/** `GET /usage/totals` — bare `UsageTotals`. */
export function getUsageTotals(range: UsageDateRange): Promise<UsageTotals> {
  return adminClient.get<UsageTotals>(`/usage/totals${rangeQuery(range)}`);
}

/** `GET /usage/by-model` — bare `ModelUsageRow[]`. */
export function getUsageByModel(range: UsageDateRange): Promise<ModelUsageRow[]> {
  return adminClient.get<ModelUsageRow[]>(`/usage/by-model${rangeQuery(range)}`);
}

/** `GET /usage/by-api-key` — bare `ApiKeyUsageRow[]`. */
export function getUsageByApiKey(range: UsageDateRange): Promise<ApiKeyUsageRow[]> {
  return adminClient.get<ApiKeyUsageRow[]>(`/usage/by-api-key${rangeQuery(range)}`);
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

/** `POST /pricing/fetch-latest`. */
export function fetchLatestPricing(): Promise<PricingFetchLatestResult> {
  return adminClient.post<PricingFetchLatestResult>('/pricing/fetch-latest');
}

/** `POST /pricing/resolve-conflicts` — stateless echo body. */
export function resolvePricingConflicts(
  resolutions: PricingConflictResolutionInput[],
): Promise<PricingResolutionResult> {
  return adminClient.post<PricingResolutionResult>('/pricing/resolve-conflicts', { resolutions });
}
