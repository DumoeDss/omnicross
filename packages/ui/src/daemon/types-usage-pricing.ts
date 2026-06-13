/**
 * types-usage-pricing.ts — hand-mirrored daemon admin-API DTOs for the Usage
 * Stats and Pricing pages (`/admin/api/usage/*`, `/admin/api/pricing*`).
 *
 * PINNED to `@omnicross/contracts` `usage-stats-types.ts` / `pricing-types.ts`
 * (the ui package deliberately has no contracts dependency — same convention
 * as `types-accounts.ts`). If the daemon's wire shapes change, update here in
 * lockstep.
 *
 * Envelope notes (daemon spec): the usage GETs return BARE DTOs; pricing list
 * returns `{ entries }`, upsert returns `{ entry }`, delete `{ deleted }`;
 * fetch-latest `{ appliedCount, conflicts, fetchedAt, sourceUrl }`;
 * resolve-conflicts `{ overwrittenCount, skippedCount, staleCount }`.
 */

/** Date range for usage queries. Unix-millis; `endTs` is EXCLUSIVE. */
export interface UsageDateRange {
  startTs: number;
  endTs: number;
}

/** Aggregated totals over a date range (`GET /usage/totals`). */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  costUsd: number;
  costSavedByCacheUsd: number;
  eventCount: number;
}

/** One row of the per-model breakdown (`GET /usage/by-model`). */
export interface ModelUsageRow {
  providerId: string;
  model: string;
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  costSavedByCacheUsd: number;
  /** True when no pricing row exists for (providerId, model). */
  unpriced: boolean;
}

/** One row of the per-API-key breakdown (`GET /usage/by-api-key`). */
export interface ApiKeyUsageRow {
  /** `null` = the unattributed sentinel group (UI renders its own label). */
  apiKeyId: string | null;
  /** Daemon-resolved display label — NOT trusted for the null group. */
  label: string;
  providerId: string | null;
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Where a pricing entry came from. */
export type PricingSource = 'builtin' | 'litellm' | 'user';

/** Per-model pricing row. Prices in USD per 1,000,000 tokens. */
export interface PricingEntry {
  providerId: string;
  modelId: string;
  inputPricePer1m: number;
  outputPricePer1m: number;
  cacheReadPricePer1m: number | null;
  cacheWritePricePer1m: number | null;
  source: PricingSource;
  userEdited: boolean;
  editedAt: number | null;
  updatedAt: number;
}

/** Upsert input shape (`PUT /pricing` body). */
export interface PricingEntryInput {
  providerId: string;
  modelId: string;
  inputPricePer1m: number;
  outputPricePer1m: number;
  cacheReadPricePer1m?: number | null;
  cacheWritePricePer1m?: number | null;
}

/** Conflict reported by fetch-latest — the local row is user-edited. */
export interface PricingConflict {
  providerId: string;
  modelId: string;
  current: PricingEntry;
  incoming: PricingEntryInput;
}

/** `POST /pricing/fetch-latest` response. */
export interface PricingFetchLatestResult {
  appliedCount: number;
  conflicts: PricingConflict[];
  fetchedAt: number;
  sourceUrl: string;
}

/** One per-conflict decision — top-level ids MUST match the echoed incoming. */
export interface PricingConflictResolutionInput {
  providerId: string;
  modelId: string;
  action: 'overwrite' | 'skip';
  /** The conflict's `incoming` entry echoed verbatim (stateless contract). */
  incoming: PricingEntryInput;
}

/** `POST /pricing/resolve-conflicts` response. */
export interface PricingResolutionResult {
  overwrittenCount: number;
  skippedCount: number;
  /** Rows that changed concurrently and were left untouched. */
  staleCount: number;
}
