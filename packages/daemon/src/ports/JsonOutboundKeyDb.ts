/**
 * JsonOutboundKeyDb — the daemon's file-backed `OutboundKeyDb` port impl
 * (design D3).
 *
 * Durable storage for named outbound API keys, backed by a json file (a sibling
 * of `config.json`, e.g. `keys.json`) holding an `OutboundKeyDbRow[]`. This port
 * provides ONLY storage — it never generates secrets nor hashes. Core's
 * `createNamedKey(db, name)` calls `outboundApiKeysCreate` with the sha256
 * `keyHash` + display `keyPrefix` and returns the one-time plaintext; the hot
 * auth path uses core's `hashKey(presented)` + `outboundApiKeysGetByHash`.
 *
 * @module @omnicross/daemon/ports/JsonOutboundKeyDb
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import type { OutboundKeyDb, OutboundKeyDbRow, OutboundKeyPolicy } from '@omnicross/core';

export class JsonOutboundKeyDb implements OutboundKeyDb {
  constructor(private readonly keysPath: string) {}

  async outboundApiKeysList(): Promise<OutboundKeyDbRow[]> {
    return this.readRows();
  }

  async outboundApiKeysGetByHash(hash: string): Promise<OutboundKeyDbRow | null> {
    const rows = this.readRows();
    const row = rows.find(
      (r) => r.keyHash === hash && r.enabled && r.revokedAt === null,
    );
    return row ?? null;
  }

  async outboundApiKeysCreate(input: {
    id: string;
    name: string;
    keyHash: string;
    keyPrefix: string;
    createdAt?: number;
  }): Promise<OutboundKeyDbRow> {
    const rows = this.readRows();
    const row: OutboundKeyDbRow = {
      id: input.id,
      name: input.name,
      keyHash: input.keyHash,
      keyPrefix: input.keyPrefix,
      enabled: true,
      createdAt: input.createdAt ?? Date.now(),
      lastUsedAt: null,
      revokedAt: null,
    };
    rows.push(row);
    this.writeRows(rows);
    return row;
  }

  async outboundApiKeysRevoke(id: string): Promise<boolean> {
    return this.mutateRow(id, (row) => {
      if (row.revokedAt !== null) return false;
      row.revokedAt = Date.now();
      row.enabled = false;
      return true;
    });
  }

  async outboundApiKeysTouchLastUsed(id: string): Promise<boolean> {
    return this.mutateRow(id, (row) => {
      row.lastUsedAt = Date.now();
      return true;
    });
  }

  async outboundApiKeysSetEnabled(id: string, enabled: boolean): Promise<boolean> {
    return this.mutateRow(id, (row) => {
      if (row.revokedAt !== null) return false;
      row.enabled = enabled;
      return true;
    });
  }

  async outboundApiKeysSetMaxConcurrency(
    id: string,
    maxConcurrency: number | null,
  ): Promise<boolean> {
    return this.mutateRow(id, (row) => {
      if (row.revokedAt !== null) return false;
      // `null` clears the ceiling (field absent = unlimited); JSON serialization
      // drops the `undefined`, so a cleared row round-trips without the field.
      if (maxConcurrency === null) delete row.maxConcurrency;
      else row.maxConcurrency = maxConcurrency;
      return true;
    });
  }

  async outboundApiKeysSetPolicy(id: string, policy: OutboundKeyPolicy): Promise<boolean> {
    return this.mutateRow(id, (row) => {
      if (row.revokedAt !== null) return false;
      // Three-way per field: a value SETS, explicit `null` CLEARS (delete →
      // absent round-trips without the field), OMISSION keeps the stored value.
      // `activatedAt` is intentionally NOT settable here.
      applyPolicyField(row, 'expiresAt', policy.expiresAt);
      applyPolicyField(row, 'activationDays', policy.activationDays);
      applyPolicyField(row, 'dailyCostLimitUsd', policy.dailyCostLimitUsd);
      applyPolicyField(row, 'totalCostLimitUsd', policy.totalCostLimitUsd);
      applyPolicyField(row, 'weeklyCostLimitUsd', policy.weeklyCostLimitUsd);
      applyPolicyField(row, 'rateLimitMaxRequests', policy.rateLimitMaxRequests);
      applyPolicyField(row, 'rateLimitWindowMs', policy.rateLimitWindowMs);
      // `activationMode` is an enum, not a number — apply with the same three-way.
      if (policy.activationMode === null) delete row.activationMode;
      else if (policy.activationMode !== undefined) row.activationMode = policy.activationMode;
      return true;
    });
  }

  async outboundApiKeysMarkActivated(id: string, activatedAt: number): Promise<boolean> {
    return this.mutateRow(id, (row) => {
      if (row.revokedAt !== null) return false;
      // Idempotent: never overwrite an existing activation stamp.
      if (row.activatedAt != null) return false;
      row.activatedAt = activatedAt;
      return true;
    });
  }

  /** Apply `fn` to the row with `id`, persisting when it returns true. */
  private mutateRow(id: string, fn: (row: OutboundKeyDbRow) => boolean): boolean {
    const rows = this.readRows();
    const row = rows.find((r) => r.id === id);
    if (!row) return false;
    const changed = fn(row);
    if (changed) this.writeRows(rows);
    return changed;
  }

  /** Read the key rows, tolerating a missing/corrupt file (→ empty list). */
  private readRows(): OutboundKeyDbRow[] {
    if (!existsSync(this.keysPath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.keysPath, 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as OutboundKeyDbRow[]) : [];
    } catch {
      return [];
    }
  }

  private writeRows(rows: OutboundKeyDbRow[]): void {
    writeFileSync(this.keysPath, JSON.stringify(rows, null, 2) + '\n', 'utf8');
  }
}

/**
 * Three-way write of a numeric-nullable policy field: `undefined` (absent in the
 * patch) keeps the stored value, `null` clears it (delete → the JSON drops the
 * `undefined` so the field round-trips absent), and a value sets it.
 */
function applyPolicyField(
  row: OutboundKeyDbRow,
  field:
    | 'expiresAt'
    | 'activationDays'
    | 'dailyCostLimitUsd'
    | 'totalCostLimitUsd'
    | 'weeklyCostLimitUsd'
    | 'rateLimitMaxRequests'
    | 'rateLimitWindowMs',
  value: number | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) delete row[field];
  else row[field] = value;
}
