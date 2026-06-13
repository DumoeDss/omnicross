/**
 * `PricingStore` — core-owned port for pricing-row persistence.
 *
 * The pricing engine performs ALL persistence through this interface; the host
 * embedder supplies the implementation at bootstrap (e.g. a SQLite table or a
 * JSON file store). Lookups never go through the store — the engine keeps an
 * in-memory cache loaded from `getAll()`.
 *
 * @module ports/pricing-store
 */
import type { PricingEntry, PricingEntryInput, PricingResolution } from '@omnicross/contracts/pricing-types';

export interface PricingStore {
  /** Return every pricing row. The engine caches the full table in memory. */
  getAll(): Promise<PricingEntry[]>;

  /**
   * Insert or update one row. When `asUserEdit` is true the store MUST mark
   * the row user-edited (source 'user', `userEdited: true`, `editedAt` now),
   * protecting it from auto-overwrite during subsequent source refreshes.
   */
  upsert(input: PricingEntryInput, asUserEdit: boolean): Promise<PricingEntry>;

  /**
   * Apply a batch of entries fetched from a pricing source.
   *
   * userEdited-conflict semantics: rows that do not exist locally, or exist
   * but are NOT user-edited, are upserted (source 'litellm', not user-edited)
   * and returned in `applied`. Rows whose local copy IS user-edited MUST be
   * left untouched and returned in `conflicts` as `{ current, incoming }`
   * pairs for per-row resolution by the user.
   */
  bulkApplyFromSource(entries: PricingEntryInput[]): Promise<{
    applied: PricingEntry[];
    conflicts: Array<{ current: PricingEntry; incoming: PricingEntryInput }>;
  }>;

  /**
   * Apply per-row conflict decisions: 'overwrite' replaces the local row with
   * the incoming values (clearing the user-edited mark), 'skip' leaves it
   * unchanged. Returns overwritten/skipped counts.
   */
  applyResolutions(
    resolutions: Array<{ incoming: PricingEntryInput; action: 'overwrite' | 'skip' }>,
  ): Promise<PricingResolution>;
}
