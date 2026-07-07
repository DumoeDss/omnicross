/**
 * Voucher (redemption-card) contracts (voucher-redemption #9, design D2/D8).
 *
 * A voucher is a redeemable credit/renewal card layered on top of the outbound
 * key-policy (#4): an admin generates a card (`CC_<entropy>`), a key-holder
 * redeems it to raise their key's `totalCostLimitUsd` (credit) or extend its
 * `expiresAt` (renewal). Dependency-light shapes shared across `@omnicross/*`:
 *
 *  - `VoucherRecord` — the FROZEN stored card. It is a CREDENTIAL RECORD but holds
 *    NO plaintext code: only the sha256 `codeHash` (the redeem lookup key) + a
 *    short display `codePrefix`. The plaintext `CC_…` is returned ONCE at
 *    generation and NEVER persisted or logged. A secret-scan test asserts no
 *    `CC_` plaintext survives in a written record.
 *  - `VoucherGrant` — the ABSOLUTE target recorded on the card at redeem time so
 *    the apply step (`outboundApiKeysSetPolicy`) is idempotently re-appliable
 *    after a crash between the CAS flip and the apply (design D4).
 *  - `VoucherInfo` — the admin-safe DTO (prefix + status + value + caps only,
 *    NEVER the `codeHash`).
 *  - `VoucherConfig` — the `voucher` config segment. `enabled` default OFF ⇒ the
 *    redeem endpoint is inert + no key is ever mutated ⇒ byte-identical zero
 *    regression, purely additive on #4.
 *
 * @module voucher-types
 */

/** A card either adds USD credit or extends the key's lifetime. */
export type VoucherType = 'credit' | 'renewal';

/** Card lifecycle. A card leaves `unredeemed` exactly once (CAS, design D4). */
export type VoucherStatus = 'unredeemed' | 'redeemed' | 'revoked';

/**
 * The ABSOLUTE grant a redemption applies to a key (design D4/D5). Recorded on
 * the voucher AT the CAS flip so re-applying it after an interrupted redeem is a
 * no-op (idempotent to the absolute value → never double-spends). A `credit`
 * card records `totalCostLimitUsd`; a `renewal` card records `expiresAt`.
 */
export interface VoucherGrant {
  /** Absolute new `totalCostLimitUsd` for the key (credit cards). */
  totalCostLimitUsd?: number;
  /** Absolute new `expiresAt` (epoch ms) for the key (renewal cards). */
  expiresAt?: number;
}

/**
 * One stored redemption card (design D2, FROZEN). Holds a HASH of the code
 * (never the plaintext) + a display prefix. The `granted*` fields are the
 * absolute target recorded at redeem time (idempotent re-apply, design D4).
 */
export interface VoucherRecord {
  /** Card id (independent of the code). */
  id: string;
  /** sha256 of the `CC_<entropy>` code — the redeem lookup key. NEVER plaintext. */
  codeHash: string;
  /** Short display prefix for the admin list (e.g. `CC_AB…`). NEVER the full code. */
  codePrefix: string;
  /** Credit (adds USD) or renewal (extends expiry). */
  type: VoucherType;
  /** `credit`: USD added to the key's `totalCostLimitUsd`. */
  creditUsd?: number;
  /** `renewal`: days added to the key's `expiresAt`. */
  renewalDays?: number;
  /** Anti-abuse cap on the RESULTING key `totalCostLimitUsd` (design D5). */
  maxTotalCostLimitUsd?: number;
  /** Anti-abuse cap on the RESULTING key lifetime, in days from now (design D5). */
  maxExpiryDays?: number;
  /** Lifecycle status. */
  status: VoucherStatus;
  /** Epoch ms the card was generated. */
  createdAt: number;
  /** Epoch ms the card was redeemed (set on the CAS flip). */
  redeemedAt?: number;
  /** The key id that redeemed the card (single-key binding). */
  redeemedByKeyId?: string;
  /**
   * Whether the grant has been APPLIED to the key (design D4, revised). The CAS
   * flip sets this `false`; the apply sets it `true` after a successful
   * `outboundApiKeysSetPolicy`. `redeemed && grantApplied !== true` means "flipped
   * but not (yet) applied" — the apply (of the recorded ABSOLUTE below) re-runs on
   * the next redeem for the key, before that redeem computes anything. It is
   * `grantApplied` that says "no work left"; the apply itself is idempotent
   * (re-applying the same absolute is a no-op), so a crash between the apply and
   * this mark never double-credits.
   */
  grantApplied?: boolean;
  /**
   * The recorded ABSOLUTE `totalCostLimitUsd` target (the intended final key
   * value), computed at flip time from the CURRENT policy read INSIDE the per-key
   * mutex. This is the AUTHORITATIVE apply source on BOTH the first pass and the
   * reconcile/replay path — re-applying it is idempotent (never double-credits).
   * Because redemptions for a key are serialized and a stranded card is reconciled
   * before the next card computes, the recorded absolute is never stale.
   */
  grantedTotalCostLimitUsd?: number;
  /** The recorded ABSOLUTE `expiresAt` target (see `grantedTotalCostLimitUsd`). */
  grantedExpiresAt?: number;
  /** Epoch ms the card was revoked. */
  revokedAt?: number;
}

/**
 * The admin-safe voucher DTO (design D2). NEVER carries the `codeHash` — the
 * admin sees the display prefix + status + value + caps only. This is the ONLY
 * projection an admin GET returns.
 */
export interface VoucherInfo {
  id: string;
  codePrefix: string;
  type: VoucherType;
  creditUsd?: number;
  renewalDays?: number;
  maxTotalCostLimitUsd?: number;
  maxExpiryDays?: number;
  status: VoucherStatus;
  createdAt: number;
  redeemedAt?: number;
  redeemedByKeyId?: string;
  grantApplied?: boolean;
  grantedTotalCostLimitUsd?: number;
  grantedExpiresAt?: number;
  revokedAt?: number;
}

/**
 * The one-time create result: `plaintextOnce` (the `CC_…` code) is shown exactly
 * once at generation and never again — only its hash is stored (design D3).
 */
export interface VoucherCreated {
  id: string;
  codePrefix: string;
  type: VoucherType;
  createdAt: number;
  /** The plaintext `CC_…` code — the ONLY time it crosses the wire. */
  plaintextOnce: string;
}

/**
 * The result a successful redeem returns to the key-holder (design D2). Reveals
 * ONLY this key's own new balance/expiry — never any other card or key.
 */
export interface VoucherRedeemResult {
  type: VoucherType;
  /** The key's new absolute `totalCostLimitUsd` (credit cards). */
  totalCostLimitUsd?: number;
  /** The key's new absolute `expiresAt` (epoch ms) (renewal cards). */
  expiresAt?: number;
}

/**
 * The `voucher` config segment (design D8), normalized like `audit`/`billing`.
 * `enabled` default FALSE ⇒ the redeem endpoint rejects + no admin generate ⇒ no
 * key is ever mutated ⇒ byte-identical zero regression, purely additive on #4.
 */
export interface VoucherConfig {
  /** Master switch; default FALSE (zero regression, inert product). */
  enabled: boolean;
}

/** Frozen defaults for the `voucher` segment (SSOT). */
export const DEFAULT_VOUCHER_CONFIG: VoucherConfig = {
  enabled: false,
};
