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
 * OPTIONAL reversible storage: when constructed with a `SecretBox`, each created
 * key ALSO persists its plaintext as a `keySecret` `enc:` envelope, powering the
 * operator "view key" affordance (`outboundApiKeysReveal`). The hash remains the
 * auth index; without a box the store is hash-only (byte-identical to legacy).
 *
 * @module @omnicross/daemon/ports/JsonOutboundKeyDb
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  validateOutboundPermissions,
  type OutboundKeyDb,
  type OutboundKeyDbRow,
  type OutboundKeyPolicy,
  type OutboundPermission,
} from '@omnicross/core';

import type { SecretBox } from '../secrets/SecretBox';

type AtomicFileReplace = (targetPath: string, contents: string) => void;

/** Same-directory temp-write + fsync + rename, so a failed write preserves the prior file. */
function atomicReplaceUtf8(targetPath: string, contents: string): void {
  const tempPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, contents, { encoding: 'utf8' });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, targetPath);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original write error.
      }
    }
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Preserve the original write error; stale temp cleanup is best-effort.
      }
    }
    throw error;
  }
}

export class JsonOutboundKeyDb implements OutboundKeyDb {
  /**
   * @param secretBox OPTIONAL reversible-secret codec. When present, a created
   * key's plaintext is persisted as a `keySecret` `enc:` envelope (enabling the
   * operator "view key" affordance via `outboundApiKeysReveal`). When absent the
   * store stays hash-only (byte-identical to the legacy behavior) and reveal
   * always returns `null`. Existing 1-arg call sites (tests, lightweight
   * embedders) keep working.
   */
  constructor(
    private readonly keysPath: string,
    private readonly secretBox?: SecretBox,
    private readonly atomicReplace: AtomicFileReplace = atomicReplaceUtf8,
  ) {}

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
    kind?: 'client' | 'integration';
    allowedEndpoints?: OutboundPermission[];
    loopbackOnly?: boolean;
    plaintext?: string;
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
      kind: input.kind,
      allowedEndpoints: input.allowedEndpoints,
      loopbackOnly: input.loopbackOnly,
    };
    // Reversible storage for the "view key" affordance. Only when both a
    // plaintext and a SecretBox are present — otherwise the row stays
    // hash-only (byte-identical to the legacy shape; reveal returns null).
    if (input.plaintext && this.secretBox) {
      row.keySecret = this.secretBox.encrypt(input.plaintext);
    }
    rows.push(row);
    this.writeRows(rows);
    return row;
  }

  async outboundApiKeysReveal(id: string): Promise<string | null> {
    const rows = this.readRows();
    const row = rows.find((r) => r.id === id);
    if (!row || !row.keySecret || !this.secretBox) return null;
    return this.secretBox.decrypt(row.keySecret);
  }

  async outboundApiKeysDelete(id: string): Promise<boolean> {
    const rows = this.readRows();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    rows.splice(idx, 1);
    this.writeRows(rows);
    return true;
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

  async outboundApiKeysSetPermissions(
    id: string,
    permissions: OutboundPermission[],
  ): Promise<boolean> {
    const exact = validateOutboundPermissions(permissions);
    return this.mutateRow(id, (row) => {
      if (row.revokedAt !== null) return false;
      row.allowedEndpoints = [...exact];
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
      // Per-key model restriction (#6) — three-way each (null clears, omit keeps).
      if (policy.enableModelRestriction === null) delete row.enableModelRestriction;
      else if (policy.enableModelRestriction !== undefined) {
        row.enableModelRestriction = policy.enableModelRestriction;
      }
      if (policy.restrictionMode === null) delete row.restrictionMode;
      else if (policy.restrictionMode !== undefined) row.restrictionMode = policy.restrictionMode;
      if (policy.restrictedModels === null) delete row.restrictedModels;
      else if (policy.restrictedModels !== undefined) row.restrictedModels = policy.restrictedModels;
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
    this.atomicReplace(this.keysPath, JSON.stringify(rows, null, 2) + '\n');
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
