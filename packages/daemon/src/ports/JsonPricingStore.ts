/**
 * JsonPricingStore — the daemon's file-backed `PricingStore` port impl.
 *
 * Durable storage for the model pricing table, backed by a pretty-printed json
 * file (a sibling of `config.json`, `pricing.json` by convention) holding a
 * `PricingEntry[]`. Reads tolerate a missing/corrupt file (→ empty table);
 * every mutation rewrites the full array (the table is at most a few thousand
 * rows — same trade-off as `JsonOutboundKeyDb`). The table starts EMPTY: no
 * seeding — the first pricing-source refresh (or a manual upsert) populates it.
 *
 * Beyond the core port, the store exposes a STORE-LOCAL `delete` (the port is
 * frozen; the admin DELETE route calls the concrete class and then invalidates
 * the engine cache).
 *
 * @module @omnicross/daemon/ports/JsonPricingStore
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import type {
  PricingEntry,
  PricingEntryInput,
  PricingResolution,
} from '@omnicross/contracts/pricing-types';
import type { AutomaticPricingSource, PricingStore } from '@omnicross/core';

export class JsonPricingStore implements PricingStore {
  constructor(private readonly pricingPath: string) {}

  /**
   * Return whether the durable snapshot can actually serve at least one price.
   *
   * This intentionally checks the file itself instead of relying on refresh
   * metadata: a recent `lastSuccessAt` must not hide a deleted, truncated, or
   * otherwise unusable pricing table after a crash or manual file edit.
   */
  hasUsableSnapshot(): boolean {
    if (!existsSync(this.pricingPath)) return false;
    try {
      const parsed = JSON.parse(readFileSync(this.pricingPath, 'utf8')) as unknown;
      return Array.isArray(parsed) && parsed.some(isUsablePricingRow);
    } catch {
      return false;
    }
  }

  async getAll(): Promise<PricingEntry[]> {
    return this.readRows();
  }

  /**
   * Insert or update one row keyed (providerId, modelId). `asUserEdit` stamps
   * user provenance (source 'user', userEdited, editedAt now) so the row is
   * protected from auto-overwrite during source refreshes; a non-user upsert
   * stamps source 'litellm' and clears nothing it should not (a plain source
   * upsert through this method overwrites the row wholesale).
   */
  async upsert(input: PricingEntryInput, asUserEdit: boolean): Promise<PricingEntry> {
    const rows = this.readRows();
    const entry = this.applyUpsert(rows, input, asUserEdit, 'litellm');
    this.writeRows(rows);
    return entry;
  }

  /**
   * Apply a batch fetched from a pricing source. Rows whose local copy is
   * user-edited are NOT applied — they come back as `{ current, incoming }`
   * conflicts; everything else is upserted with the supplied automatic source.
   * ONE file write for the whole batch.
   */
  async bulkApplyFromSource(
    entries: PricingEntryInput[],
    source: AutomaticPricingSource = 'litellm',
  ): Promise<{
    applied: PricingEntry[];
    conflicts: Array<{ current: PricingEntry; incoming: PricingEntryInput }>;
  }> {
    const rows = this.readRows();
    const applied: PricingEntry[] = [];
    const conflicts: Array<{ current: PricingEntry; incoming: PricingEntryInput }> = [];
    for (const incoming of entries) {
      const current = rows.find(
        (r) => r.providerId === incoming.providerId && r.modelId === incoming.modelId,
      );
      if (current && current.userEdited) {
        conflicts.push({ current, incoming });
        continue;
      }
      applied.push(this.applyUpsert(rows, incoming, /* asUserEdit */ false, source));
    }
    if (applied.length > 0) this.writeRows(rows);
    return { applied, conflicts };
  }

  /**
   * Apply per-row conflict decisions: 'overwrite' replaces the local row with
   * the incoming values (clearing the user-edited mark), 'skip' counts only.
   */
  async applyResolutions(
    resolutions: Array<{ incoming: PricingEntryInput; action: 'overwrite' | 'skip' }>,
  ): Promise<PricingResolution> {
    const rows = this.readRows();
    let overwrittenCount = 0;
    let skippedCount = 0;
    for (const r of resolutions) {
      if (r.action === 'skip') {
        skippedCount += 1;
        continue;
      }
      this.applyUpsert(rows, r.incoming, /* asUserEdit */ false, 'litellm');
      overwrittenCount += 1;
    }
    if (overwrittenCount > 0) this.writeRows(rows);
    return { overwrittenCount, skippedCount };
  }

  /**
   * STORE-LOCAL (not on the core port): remove one row. Returns whether a row
   * was actually removed. The admin DELETE handler calls this then invalidates
   * the engine cache.
   */
  async delete(providerId: string, modelId: string): Promise<boolean> {
    const rows = this.readRows();
    const idx = rows.findIndex((r) => r.providerId === providerId && r.modelId === modelId);
    if (idx < 0) return false;
    rows.splice(idx, 1);
    this.writeRows(rows);
    return true;
  }

  /** Upsert into `rows` IN PLACE (no write) and return the resulting entry. */
  private applyUpsert(
    rows: PricingEntry[],
    input: PricingEntryInput,
    asUserEdit: boolean,
    automaticSource: AutomaticPricingSource,
  ): PricingEntry {
    const now = Date.now();
    const entry: PricingEntry = {
      providerId: input.providerId,
      modelId: input.modelId,
      inputPricePer1m: input.inputPricePer1m,
      outputPricePer1m: input.outputPricePer1m,
      cacheReadPricePer1m: input.cacheReadPricePer1m ?? null,
      cacheWritePricePer1m: input.cacheWritePricePer1m ?? null,
      source: asUserEdit ? 'user' : automaticSource,
      userEdited: asUserEdit,
      editedAt: asUserEdit ? now : null,
      updatedAt: now,
    };
    const idx = rows.findIndex(
      (r) => r.providerId === input.providerId && r.modelId === input.modelId,
    );
    if (idx >= 0) rows[idx] = entry;
    else rows.push(entry);
    return entry;
  }

  /** Read the pricing rows, tolerating a missing/corrupt file (→ empty list). */
  private readRows(): PricingEntry[] {
    if (!existsSync(this.pricingPath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.pricingPath, 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as PricingEntry[]) : [];
    } catch {
      return [];
    }
  }

  private writeRows(rows: PricingEntry[]): void {
    // The temporary file lives beside the destination so rename remains an
    // atomic same-volume replacement. Node/libuv uses replace-existing
    // semantics on Windows. If replacement still fails (for example because a
    // scanner temporarily locks the destination), never unlink the healthy
    // snapshot: surface the mutation failure and only remove our temp file.
    const temporaryPath = `${this.pricingPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(rows, null, 2) + '\n', {
        encoding: 'utf8',
        flag: 'wx',
      });
      this.replaceFile(temporaryPath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }

  /** Isolated for deterministic failure testing; never removes the target. */
  private replaceFile(temporaryPath: string): void {
    renameSync(temporaryPath, this.pricingPath);
  }
}

function isUsablePricingRow(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.providerId === 'string' &&
    row.providerId.length > 0 &&
    typeof row.modelId === 'string' &&
    row.modelId.length > 0 &&
    typeof row.inputPricePer1m === 'number' &&
    Number.isFinite(row.inputPricePer1m) &&
    typeof row.outputPricePer1m === 'number' &&
    Number.isFinite(row.outputPricePer1m)
  );
}
