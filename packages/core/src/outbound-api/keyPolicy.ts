/**
 * keyPolicy — PURE decision helpers for the outbound key-policy envelope
 * (`outbound-key-policy`, design D2/D4). Expiry/activation resolution +
 * cost-quota decision. No I/O, no clock ownership (the caller passes `now`), so
 * these are trivially unit-testable and reused by both the auth path
 * (`verifyKey`) and the wire path (`outboundApiRouter`).
 *
 * The #6 (`restrictedModels`) and #9 (voucher) children EXTEND the key-policy
 * schema; they must not change the shapes frozen here.
 *
 * @module outbound-api/keyPolicy
 */

/** Milliseconds in a day (activation-window arithmetic). */
const DAY_MS = 86_400_000;

/** The expiry/activation subset of a key row `computeKeyExpiry` reads. */
export interface KeyExpiryInput {
  /** Fixed-mode absolute expiry (epoch ms). */
  expiresAt?: number | null;
  /** Expiry mode; absent ⇒ `'fixed'`. */
  activationMode?: 'fixed' | 'activation';
  /** Activation-mode lifetime in days (absent/null ⇒ never expires). */
  activationDays?: number | null;
  /** First-use activation stamp (epoch ms); null ⇒ not yet activated. */
  activatedAt?: number | null;
}

/** Result of {@link computeKeyExpiry}. */
export interface KeyExpiryResult {
  expired: boolean;
  /** The resolved absolute expiry (epoch ms), when the key has one. */
  effectiveExpiresAt?: number;
  /**
   * True when this is an activation-mode key that has NOT been activated yet, so
   * the caller SHOULD stamp the activation (best-effort) on a successful verify.
   */
  needsActivation?: boolean;
}

/**
 * Resolve whether a key is past its effective expiry (design D2).
 *  - `fixed`: expired when `expiresAt != null && now >= expiresAt`.
 *  - `activation`: while `activatedAt == null` the key is NOT expired (it
 *    activates on THIS use → `needsActivation`); once activated, expired when
 *    `now >= activatedAt + activationDays*DAY`. A null `activationDays` never
 *    expires.
 * A key with no expiry configured never expires.
 */
export function computeKeyExpiry(row: KeyExpiryInput, now: number): KeyExpiryResult {
  const mode = row.activationMode ?? 'fixed';
  if (mode === 'activation') {
    if (row.activatedAt == null) return { expired: false, needsActivation: true };
    if (row.activationDays == null) return { expired: false };
    const effectiveExpiresAt = row.activatedAt + row.activationDays * DAY_MS;
    return { expired: now >= effectiveExpiresAt, effectiveExpiresAt };
  }
  // fixed
  if (row.expiresAt == null) return { expired: false };
  return { expired: now >= row.expiresAt, effectiveExpiresAt: row.expiresAt };
}

/** Per-key USD cost limits carried on the verified key (absent scope ⇒ no cap). */
export interface KeyCostLimits {
  dailyUsd?: number;
  totalUsd?: number;
  weeklyUsd?: number;
}

/** In-memory per-key accumulated spend snapshot (see `keySpendTracker`). */
export interface KeySpend {
  dailyUsd: number;
  /** Local-midnight boundary the `dailyUsd` window opened at (epoch ms). */
  dailyWindowStart: number;
  weeklyUsd: number;
  /** Local week-start boundary the `weeklyUsd` window opened at (epoch ms). */
  weeklyWindowStart: number;
  totalUsd: number;
}

/** Decision returned by {@link checkKeyQuota}. */
export type QuotaDecision =
  | { allowed: true }
  | { allowed: false; scope: 'daily' | 'weekly' | 'total'; limitUsd: number; spentUsd: number };

/**
 * Decide whether the key's accumulated spend already meets/exceeds any
 * configured cost limit (design D4). `allowed:false` when a scope's PRIOR spend
 * is `>= limit` (the triggering request's own cost is unknown pre-flight →
 * bounded one-request overage, CRS-equivalent). An unconfigured scope is never
 * gated; a `limits`-less key always passes.
 */
export function checkKeyQuota(
  limits: KeyCostLimits | undefined,
  spend: KeySpend,
): QuotaDecision {
  if (!limits) return { allowed: true };
  if (limits.dailyUsd != null && spend.dailyUsd >= limits.dailyUsd) {
    return { allowed: false, scope: 'daily', limitUsd: limits.dailyUsd, spentUsd: spend.dailyUsd };
  }
  if (limits.weeklyUsd != null && spend.weeklyUsd >= limits.weeklyUsd) {
    return { allowed: false, scope: 'weekly', limitUsd: limits.weeklyUsd, spentUsd: spend.weeklyUsd };
  }
  if (limits.totalUsd != null && spend.totalUsd >= limits.totalUsd) {
    return { allowed: false, scope: 'total', limitUsd: limits.totalUsd, spentUsd: spend.totalUsd };
  }
  return { allowed: true };
}

/**
 * Per-key model restriction carried on the verified key (outbound-key-policy #6).
 * Present ONLY when the key has `enableModelRestriction === true` — so the wire
 * layer's presence check (`if (key.modelRestriction) …`) is the zero-regression
 * gate.
 */
export interface ModelRestriction {
  mode: 'blacklist' | 'allowlist';
  /** Bare modelIds the mode acts on. Empty allowlist denies every model. */
  models: string[];
}

/** Decision returned by {@link checkModelAllowed}. */
export type ModelDecision = { allowed: true } | { allowed: false; model: string };

/**
 * Canonicalize a model id or `"providerId,modelId"` ref to the ONE comparison
 * form: the bare, trimmed, lower-cased modelId. Normalizing both the resolved
 * model and every list entry to this form makes membership case-insensitive and
 * ref-shape-insensitive (design D3 "canonical form = bare modelId").
 */
function canonicalModelId(value: string): string {
  const idx = value.indexOf(',');
  const bare = idx >= 0 ? value.slice(idx + 1) : value;
  return bare.trim().toLowerCase();
}

/**
 * Decide whether the key may use the RESOLVED upstream model (design D3).
 * Matching the resolved model id (post kind-mapping), NOT the raw client string,
 * is alias-proof — a versioned/aliased id that maps to a restricted model cannot
 * bypass the block. `undefined` restriction ⇒ always allowed (the wire layer only
 * calls this for a restriction-bearing key). Membership is exact + case-
 * insensitive on the canonical bare modelId. `blacklist` denies IN-list models;
 * `allowlist` denies models NOT in the list (an empty allowlist denies all). On a
 * deny, `model` is the original resolved id (for a readable 403 body).
 */
export function checkModelAllowed(
  restriction: ModelRestriction | undefined,
  resolvedModelId: string,
): ModelDecision {
  if (!restriction) return { allowed: true };
  const target = canonicalModelId(resolvedModelId);
  const listed = restriction.models.some((m) => canonicalModelId(m) === target);
  if (restriction.mode === 'allowlist') {
    return listed ? { allowed: true } : { allowed: false, model: resolvedModelId };
  }
  // blacklist
  return listed ? { allowed: false, model: resolvedModelId } : { allowed: true };
}
