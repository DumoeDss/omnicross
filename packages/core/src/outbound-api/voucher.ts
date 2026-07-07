/**
 * voucher — the `VoucherDb` port + PURE code/grant helpers for the voucher
 * redemption system (voucher-redemption #9, design D2/D3/D4/D5/D7).
 *
 * Layered on top of the #4 outbound key-policy: a voucher redemption only
 * MUTATES a key's `totalCostLimitUsd` (credit) or `expiresAt` (renewal) through
 * the already-built `outboundApiKeysSetPolicy` enforcement — no new key fields.
 *
 * This module is pure logic + a store port:
 *  - Code generation reuses the key-auth unbiased base62 generator (`CC_` prefix)
 *    and sha256 hashing — the plaintext is returned once and NEVER persisted.
 *  - `computeVoucherGrant` derives the ABSOLUTE grant target (with per-card caps)
 *    from the current key policy — recorded on the card so the apply step is
 *    idempotently re-appliable after an interrupted redeem (design D4).
 *  - `VoucherDb` mirrors `OutboundKeyDb` with an ATOMIC status compare-and-set
 *    (`redeemCas`/`revokeCas`) — the single-use guarantee.
 *
 * @module outbound-api/voucher
 */

import { createHash } from 'node:crypto';

import type {
  VoucherGrant,
  VoucherInfo,
  VoucherRecord,
} from '@omnicross/contracts/voucher-types';

import { randomBase62 } from './outboundApiKeyAuth';
import type { OutboundKeyDbRow } from './types';

/** Bytes of entropy in a generated voucher code (256-bit → 43 base62 chars). */
const CODE_ENTROPY_CHARS = 32;
/** All voucher codes carry this human-recognizable prefix. */
const CODE_PREFIX = 'CC_';
/** Length of the stored display prefix (chars of the full code, incl. `CC_`). */
const DISPLAY_PREFIX_LEN = 8;
/** Milliseconds in a day (renewal arithmetic). */
const DAY_MS = 86_400_000;

/**
 * Generate a fresh high-entropy voucher code: `CC_<base62>`. Reuses the key-auth
 * unbiased (rejection-sampled) base62 generator, so a code is a ~190-bit
 * credential — guessing is infeasible (design D3). The plaintext is returned ONCE
 * at generation and NEVER persisted or logged.
 */
export function generateVoucherCode(): string {
  return CODE_PREFIX + randomBase62(CODE_ENTROPY_CHARS);
}

/** Hash a presented/generated voucher code (sha256 hex) — the redeem lookup key. */
export function hashVoucherCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** The short display prefix stored alongside the hash (e.g. `CC_AB12`). */
export function voucherCodePrefix(code: string): string {
  return code.slice(0, DISPLAY_PREFIX_LEN);
}

/** A small id for a created voucher (independent of the code). */
export function newVoucherId(): string {
  return `vch_${Date.now()}_${randomBase62(8)}`;
}

/**
 * Compute the ABSOLUTE grant target a redemption should apply to a key (design
 * D5), clamped by the card's per-card anti-abuse caps. Pure — the caller records
 * this on the card at the CAS flip AND applies the same absolute via
 * `outboundApiKeysSetPolicy`, so an interrupted redeem is idempotently
 * re-appliable (never double-spends).
 *
 *  - `credit`  → `min((current.totalCostLimitUsd ?? 0) + creditUsd, maxTotalCostLimitUsd ?? ∞)`.
 *    Raising the ceiling above accumulated spend lets an over-limit key resume
 *    (the #4 spend tracker keeps the spend; only the ceiling rises).
 *  - `renewal` → `min((current.expiresAt ?? now) + renewalDays·DAY, now + maxExpiryDays·DAY ?? ∞)`.
 */
export function computeVoucherGrant(
  voucher: VoucherRecord,
  currentKey: Pick<OutboundKeyDbRow, 'totalCostLimitUsd' | 'expiresAt'> | null | undefined,
  now: number,
): VoucherGrant {
  if (voucher.type === 'credit') {
    const current = currentKey?.totalCostLimitUsd ?? 0;
    let granted = current + (voucher.creditUsd ?? 0);
    if (voucher.maxTotalCostLimitUsd != null) {
      granted = Math.min(granted, voucher.maxTotalCostLimitUsd);
    }
    return { totalCostLimitUsd: granted };
  }
  // renewal
  const currentExpiry = currentKey?.expiresAt ?? now;
  let granted = currentExpiry + (voucher.renewalDays ?? 0) * DAY_MS;
  if (voucher.maxExpiryDays != null) {
    granted = Math.min(granted, now + voucher.maxExpiryDays * DAY_MS);
  }
  return { expiresAt: granted };
}

/**
 * Project a stored voucher to the admin-safe DTO (design D2). Strips the
 * `codeHash` — the admin sees the display prefix + status + value + caps only,
 * NEVER the hash. This is the ONLY projection an admin GET returns.
 */
export function toVoucherInfo(v: VoucherRecord): VoucherInfo {
  const info: VoucherInfo = {
    id: v.id,
    codePrefix: v.codePrefix,
    type: v.type,
    status: v.status,
    createdAt: v.createdAt,
  };
  if (v.creditUsd != null) info.creditUsd = v.creditUsd;
  if (v.renewalDays != null) info.renewalDays = v.renewalDays;
  if (v.maxTotalCostLimitUsd != null) info.maxTotalCostLimitUsd = v.maxTotalCostLimitUsd;
  if (v.maxExpiryDays != null) info.maxExpiryDays = v.maxExpiryDays;
  if (v.redeemedAt != null) info.redeemedAt = v.redeemedAt;
  if (v.redeemedByKeyId != null) info.redeemedByKeyId = v.redeemedByKeyId;
  if (v.grantApplied != null) info.grantApplied = v.grantApplied;
  if (v.grantedTotalCostLimitUsd != null) info.grantedTotalCostLimitUsd = v.grantedTotalCostLimitUsd;
  if (v.grantedExpiresAt != null) info.grantedExpiresAt = v.grantedExpiresAt;
  if (v.revokedAt != null) info.revokedAt = v.revokedAt;
  return info;
}

/** Input to `VoucherDb.create` — the card fields minus the derived lifecycle. */
export interface VoucherCreateInput {
  id: string;
  codeHash: string;
  codePrefix: string;
  type: VoucherRecord['type'];
  creditUsd?: number;
  renewalDays?: number;
  maxTotalCostLimitUsd?: number;
  maxExpiryDays?: number;
  createdAt?: number;
}

/**
 * The voucher store port (design D7), mirroring `OutboundKeyDb`. The daemon
 * implements it over the SAME update-capable mechanism the key store uses (a JSON
 * file with a synchronous read-check-write that is atomic within Node's single
 * thread — NOT an append-only jsonl, which cannot flip a status in place).
 *
 * `redeemCas`/`revokeCas` are ATOMIC compare-and-sets: they transition the card
 * out of `unredeemed` ONLY IF it is still `unredeemed`, returning whether THIS
 * call won. A concurrent second redeem loses (returns false) — the single-use
 * guarantee (design D4).
 */
export interface VoucherDb {
  /** Create + persist a card (status `unredeemed`). */
  voucherCreate(input: VoucherCreateInput): Promise<VoucherRecord>;
  /** Look up a card by its code hash (the redeem lookup). Null when absent. */
  voucherGetByHash(codeHash: string): Promise<VoucherRecord | null>;
  /**
   * ATOMIC single-use flip `unredeemed → redeemed`, recording the redeeming key
   * id + the AUDIT `granted*` snapshot and setting `grantApplied = false`. Returns
   * true when THIS call won the CAS (the card was still `unredeemed`), false when
   * it lost (already redeemed/revoked) — the single-use guard (design D4). The
   * grant is NOT applied here; the caller applies a RELATIVE increment then calls
   * {@link voucherMarkGrantApplied}.
   */
  voucherRedeemCas(
    id: string,
    keyId: string,
    granted: VoucherGrant,
    now: number,
  ): Promise<boolean>;
  /**
   * Mark a redeemed card's grant as APPLIED (`grantApplied = true`), AFTER the
   * key policy write succeeded (MJ1 fix). The guard against a replay double-add:
   * a `redeemed` card with `grantApplied === true` is never re-applied. Returns
   * false when the card is missing/not redeemed.
   */
  voucherMarkGrantApplied(id: string): Promise<boolean>;
  /**
   * Revert a flip whose grant apply FAILED (M3): `redeemed → unredeemed`, clearing
   * the redeem bookkeeping, ONLY IF the card is `redeemed`, was redeemed by
   * `keyId`, and `grantApplied !== true` (never revert an applied grant). Returns
   * true when reverted, false otherwise. Lets the holder retry a card whose apply
   * hit a transient key error instead of silently losing it.
   */
  voucherRevertRedeem(id: string, keyId: string): Promise<boolean>;
  /**
   * ATOMIC flip `unredeemed → revoked`. Returns true when THIS call won (the card
   * was still `unredeemed`), false otherwise — a REDEEMED card can NEVER be
   * revoked (design D6).
   */
  voucherRevokeCas(id: string, now: number): Promise<boolean>;
  /** List all cards (admin; the caller projects to `VoucherInfo` — no hash out). */
  voucherList(): Promise<VoucherRecord[]>;
}
