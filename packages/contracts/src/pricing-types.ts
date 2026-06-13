/**
 * Model pricing types — provider-generic pricing-table contracts.
 *
 * Pricing rows are keyed by (providerId, modelId) and persisted by the
 * embedding host's own store. The serving core's pricing engine uses them to
 * derive `costUsd` for each captured usage event; hosts may also surface the
 * rows in their own pricing-management UI.
 *
 * @module pricing-types
 */

/** Where this pricing entry came from. */
export type PricingSource =
  /** Built-in fallback shipped by the host, seeded on first run. */
  | 'builtin'
  /** Auto-fetched from the LiteLLM JSON URL. */
  | 'litellm'
  /** Hand-edited by the user; protected from auto-overwrite. */
  | 'user';

/**
 * Per-model pricing row keyed by (providerId, modelId). Prices are in USD per
 * 1,000,000 tokens. `cache_read` / `cache_write` are optional — providers
 * without prompt caching leave them null.
 */
export interface PricingEntry {
  providerId: string;
  modelId: string;
  inputPricePer1m: number;
  outputPricePer1m: number;
  cacheReadPricePer1m: number | null;
  cacheWritePricePer1m: number | null;
  source: PricingSource;
  /** True when the row has been hand-edited. Protects it from auto-overwrite during a source refresh. */
  userEdited: boolean;
  /** Unix-millis of the most recent user edit, or null if never. */
  editedAt: number | null;
  /** Unix-millis of the most recent write of any kind. */
  updatedAt: number;
}

/** Upsert input shape (manual edits and parsed source entries). */
export type PricingEntryInput = {
  providerId: string;
  modelId: string;
  inputPricePer1m: number;
  outputPricePer1m: number;
  cacheReadPricePer1m?: number | null;
  cacheWritePricePer1m?: number | null;
};

/** Conflict reported during a source refresh — local row was user-edited. */
export interface PricingConflict {
  providerId: string;
  modelId: string;
  /** Existing row in the local store (before any change). */
  current: PricingEntry;
  /** Incoming row from the pricing source. */
  incoming: PricingEntryInput;
}

/** Result of a source refresh. The auto-applied entries are already written. */
export interface PricingFetchResult {
  /** Rows that were upserted automatically (new or non-userEdited). */
  applied: PricingEntry[];
  /** Rows where the local copy is userEdited — surfaced to the UI for resolution. */
  conflicts: PricingConflict[];
  /** When the fetch started (unix-millis). */
  fetchedAt: number;
  /** Source URL that was fetched. */
  sourceUrl: string;
}

/** Per-row decision passed back from the host's conflict-resolution UI. */
export interface PricingConflictDecision {
  providerId: string;
  modelId: string;
  action: 'overwrite' | 'skip';
}

/** Outcome of resolving a list of conflict decisions. */
export interface PricingResolution {
  /** Number of rows overwritten with the incoming source values. */
  overwrittenCount: number;
  /** Number of rows left unchanged (skipped). */
  skippedCount: number;
}

/** Default LiteLLM source URL — public model_prices_and_context_window.json. */
export const DEFAULT_LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
