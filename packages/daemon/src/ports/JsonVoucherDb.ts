/**
 * JsonVoucherDb — the daemon's file-backed `VoucherDb` port impl
 * (voucher-redemption #9, design D7).
 *
 * Durable storage for redemption cards, backed by a json file (a sibling of
 * `config.json`, e.g. `vouchers.json`) holding a `VoucherRecord[]`. It mirrors
 * `JsonOutboundKeyDb` — the SAME update-capable mechanism the key store uses, so
 * it supports the atomic status compare-and-set that a jsonl append-only log
 * cannot.
 *
 * ATOMICITY: every mutation is a fully SYNCHRONOUS read-check-write
 * (`readFileSync` → check status → `writeFileSync`) with NO `await` between the
 * read and the write, so it is atomic within Node's single-threaded event loop —
 * a concurrent second redeem cannot interleave and observe a stale `unredeemed`.
 * `voucherRedeemCas`/`voucherRevokeCas` flip the card out of `unredeemed` ONLY IF
 * it is still `unredeemed`, returning whether THIS call won — the single-use
 * guarantee (design D4).
 *
 * The store NEVER holds a plaintext code — only the sha256 `codeHash` + display
 * `codePrefix` core computed at generation.
 *
 * @module @omnicross/daemon/ports/JsonVoucherDb
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import type { VoucherGrant, VoucherRecord } from '@omnicross/contracts/voucher-types';
import type { VoucherCreateInput, VoucherDb } from '@omnicross/core/outbound-api';

export class JsonVoucherDb implements VoucherDb {
  constructor(private readonly vouchersPath: string) {}

  async voucherCreate(input: VoucherCreateInput): Promise<VoucherRecord> {
    const rows = this.readRows();
    const row: VoucherRecord = {
      id: input.id,
      codeHash: input.codeHash,
      codePrefix: input.codePrefix,
      type: input.type,
      status: 'unredeemed',
      createdAt: input.createdAt ?? Date.now(),
    };
    if (input.creditUsd != null) row.creditUsd = input.creditUsd;
    if (input.renewalDays != null) row.renewalDays = input.renewalDays;
    if (input.maxTotalCostLimitUsd != null) row.maxTotalCostLimitUsd = input.maxTotalCostLimitUsd;
    if (input.maxExpiryDays != null) row.maxExpiryDays = input.maxExpiryDays;
    rows.push(row);
    this.writeRows(rows);
    return row;
  }

  async voucherGetByHash(codeHash: string): Promise<VoucherRecord | null> {
    const rows = this.readRows();
    return rows.find((r) => r.codeHash === codeHash) ?? null;
  }

  async voucherRedeemCas(
    id: string,
    keyId: string,
    granted: VoucherGrant,
    now: number,
  ): Promise<boolean> {
    // Atomic read-check-write: the whole body is synchronous, so a concurrent
    // second redeem can never interleave between the status check and the write.
    const rows = this.readRows();
    const row = rows.find((r) => r.id === id);
    // CAS guard: only an UNREDEEMED card can be redeemed. A card already
    // redeemed/revoked loses the race here (returns false) — single-use (D4).
    if (!row || row.status !== 'unredeemed') return false;
    row.status = 'redeemed';
    row.redeemedAt = now;
    row.redeemedByKeyId = keyId;
    // `grantApplied` starts false — the caller applies a RELATIVE increment then
    // calls `voucherMarkGrantApplied` (MJ1 fix). The `granted*` fields are only an
    // informational AUDIT snapshot, NO LONGER the apply source.
    row.grantApplied = false;
    if (granted.totalCostLimitUsd != null) row.grantedTotalCostLimitUsd = granted.totalCostLimitUsd;
    if (granted.expiresAt != null) row.grantedExpiresAt = granted.expiresAt;
    this.writeRows(rows);
    return true;
  }

  async voucherMarkGrantApplied(id: string): Promise<boolean> {
    const rows = this.readRows();
    const row = rows.find((r) => r.id === id);
    if (!row || row.status !== 'redeemed') return false;
    if (row.grantApplied === true) return true; // already marked (idempotent)
    row.grantApplied = true;
    this.writeRows(rows);
    return true;
  }

  async voucherRevertRedeem(id: string, keyId: string): Promise<boolean> {
    const rows = this.readRows();
    const row = rows.find((r) => r.id === id);
    // Only revert an UNAPPLIED flip by THIS key — never undo an applied grant.
    if (!row || row.status !== 'redeemed' || row.grantApplied === true) return false;
    if (row.redeemedByKeyId !== keyId) return false;
    row.status = 'unredeemed';
    delete row.redeemedAt;
    delete row.redeemedByKeyId;
    delete row.grantApplied;
    delete row.grantedTotalCostLimitUsd;
    delete row.grantedExpiresAt;
    this.writeRows(rows);
    return true;
  }

  async voucherRevokeCas(id: string, now: number): Promise<boolean> {
    const rows = this.readRows();
    const row = rows.find((r) => r.id === id);
    // Only an UNREDEEMED card can be revoked — a REDEEMED card can NEVER be
    // revoked (design D6). A synchronous check-then-write (atomic in Node).
    if (!row || row.status !== 'unredeemed') return false;
    row.status = 'revoked';
    row.revokedAt = now;
    this.writeRows(rows);
    return true;
  }

  async voucherList(): Promise<VoucherRecord[]> {
    return this.readRows();
  }

  /** Read the voucher rows, tolerating a missing/corrupt file (→ empty list). */
  private readRows(): VoucherRecord[] {
    if (!existsSync(this.vouchersPath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.vouchersPath, 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as VoucherRecord[]) : [];
    } catch {
      return [];
    }
  }

  private writeRows(rows: VoucherRecord[]): void {
    writeFileSync(this.vouchersPath, JSON.stringify(rows, null, 2) + '\n', 'utf8');
  }
}
