/**
 * outboundApiKeyAuth — named-key generation, hashing, and verification for the
 * outbound API server (`outbound-api-server`).
 *
 * Keys are 128-bit+ random secrets (`sk-omnicross-<base62>`), NOT human passwords,
 * so a single fast hash (sha256) is sufficient and keeps the hot auth path
 * cheap (design D3). Only the hash + a short display prefix are persisted; the
 * full plaintext is returned exactly once at creation.
 *
 * @module outbound-api/outboundApiKeyAuth
 */

import { createHash, randomBytes } from 'node:crypto';

import { computeKeyExpiry, type KeyCostLimits, type ModelRestriction } from './keyPolicy';
import type { OutboundApiKeyCreated, OutboundKeyDb, OutboundKeyDbRow } from './types';

/** Bytes of entropy in a generated secret (256-bit → 43 base62 chars). */
const SECRET_BYTES = 32;
/** Length of the stored display prefix (chars of the full secret). */
const PREFIX_LEN = 14;
/** All keys carry this human-recognizable prefix. */
const KEY_PREFIX = 'sk-omnicross-';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Largest multiple of 62 that fits in a byte (4×62); bytes ≥ this are rejected. */
const BASE62_REJECT_THRESHOLD = 248;

/**
 * Produce `count` UNBIASED base62 chars (t2). Uses rejection sampling — bytes in
 * `[248, 256)` are discarded so the remaining `[0, 248)` map uniformly onto the
 * 62 alphabet (each char equally likely), eliminating the `byte % 62` modulo
 * bias. Draws fresh random bytes in batches until enough chars are accepted.
 */
export function randomBase62(count: number): string {
  let out = '';
  while (out.length < count) {
    const buf = randomBytes(count - out.length + 8);
    for (const byte of buf) {
      if (out.length >= count) break;
      if (byte >= BASE62_REJECT_THRESHOLD) continue; // reject to avoid modulo bias
      out += BASE62[byte % 62];
    }
  }
  return out;
}

/** Generate a fresh high-entropy secret: `sk-omnicross-<base62>`. */
export function generateSecret(): string {
  return KEY_PREFIX + randomBase62(SECRET_BYTES);
}

/** Hash a presented/generated secret (sha256 hex). */
export function hashKey(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** The short display prefix stored alongside the hash (first ~14 chars). */
export function keyPrefix(secret: string): string {
  return secret.slice(0, PREFIX_LEN);
}

/** A small id for a created key (independent of the secret). */
export function newKeyId(): string {
  return `oak_${Date.now()}_${randomBytes(6).toString('hex')}`;
}

/**
 * Create + persist a named key. Returns the plaintext ONCE; only the hash +
 * prefix are stored.
 */
export async function createNamedKey(
  db: OutboundKeyDb,
  name: string,
): Promise<OutboundApiKeyCreated> {
  const secret = generateSecret();
  const id = newKeyId();
  const prefix = keyPrefix(secret);
  const row = await db.outboundApiKeysCreate({
    id,
    name,
    keyHash: hashKey(secret),
    keyPrefix: prefix,
  });
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    createdAt: row.createdAt,
    plaintextOnce: secret,
  };
}

/**
 * A verified key + the enforcement inputs carried from the row so the wire layer
 * runs its policy checks WITHOUT a second DB read (mirrors `maxConcurrency`).
 */
export interface VerifiedKey {
  id: string;
  /**
   * The key's per-key concurrency ceiling, carried from the row so the wire
   * layer keys the concurrency gate without a second DB read. Absent/`0` =
   * unlimited (gate bypassed).
   */
  maxConcurrency?: number;
  /**
   * Per-key USD cost limits (outbound-key-policy). Absent when the key has no
   * cost cap → the wire layer skips the cost-quota check entirely.
   */
  costLimits?: KeyCostLimits;
  /**
   * Per-key rate-limit override (outbound-key-policy). Absent when the key has no
   * rate config → the limiter uses its default 60/60s window (byte-identical).
   */
  rateLimit?: { maxRequests?: number; windowMs?: number };
  /**
   * Per-key model restriction (outbound-key-policy #6). Populated ONLY when the
   * row has `enableModelRestriction === true` → the wire layer's presence check
   * is the zero-regression gate. Absent ⇒ NO model check runs for this key.
   */
  modelRestriction?: ModelRestriction;
}

/** The reason-bearing verify outcome (design D2). */
export type KeyVerification =
  | { status: 'ok'; key: VerifiedKey }
  | { status: 'invalid' } // not found / disabled / revoked → 401
  | { status: 'expired' }; // past effective expiry → 401

/** Extract the per-key cost limits from a row, or undefined when none are set. */
function extractCostLimits(row: OutboundKeyDbRow): KeyCostLimits | undefined {
  const limits: KeyCostLimits = {};
  if (row.dailyCostLimitUsd != null) limits.dailyUsd = row.dailyCostLimitUsd;
  if (row.totalCostLimitUsd != null) limits.totalUsd = row.totalCostLimitUsd;
  if (row.weeklyCostLimitUsd != null) limits.weeklyUsd = row.weeklyCostLimitUsd;
  return limits.dailyUsd != null || limits.totalUsd != null || limits.weeklyUsd != null
    ? limits
    : undefined;
}

/** Extract the per-key rate override from a row, or undefined when none is set. */
function extractRateLimit(
  row: OutboundKeyDbRow,
): { maxRequests?: number; windowMs?: number } | undefined {
  if (row.rateLimitMaxRequests == null && row.rateLimitWindowMs == null) return undefined;
  const override: { maxRequests?: number; windowMs?: number } = {};
  if (row.rateLimitMaxRequests != null) override.maxRequests = row.rateLimitMaxRequests;
  if (row.rateLimitWindowMs != null) override.windowMs = row.rateLimitWindowMs;
  return override;
}

/**
 * Extract the per-key model restriction from a row, or undefined when it is not
 * ENABLED (#6). The master switch `enableModelRestriction` is the zero-regression
 * gate: a row with it off/unset yields `undefined` here, so the verified key
 * carries no restriction and the wire layer skips the whole check. Mode defaults
 * to `'blacklist'`; a missing list is treated as empty.
 */
function extractModelRestriction(row: OutboundKeyDbRow): ModelRestriction | undefined {
  if (row.enableModelRestriction !== true) return undefined;
  return {
    mode: row.restrictionMode ?? 'blacklist',
    models: row.restrictedModels ?? [],
  };
}

/** Project a stored row to the verified key, carrying its policy inputs through. */
function toVerifiedKey(row: OutboundKeyDbRow): VerifiedKey {
  const key: VerifiedKey = { id: row.id };
  if (row.maxConcurrency !== undefined && row.maxConcurrency !== null) {
    key.maxConcurrency = row.maxConcurrency;
  }
  const costLimits = extractCostLimits(row);
  if (costLimits) key.costLimits = costLimits;
  const rateLimit = extractRateLimit(row);
  if (rateLimit) key.rateLimit = rateLimit;
  const modelRestriction = extractModelRestriction(row);
  if (modelRestriction) key.modelRestriction = modelRestriction;
  return key;
}

/**
 * Verify a presented key against the DB, returning a REASON (design D2) so the
 * wire layer can emit the right status + a clear body. Matches by hash where the
 * stored row is enabled AND not revoked. On a valid, non-expired key: bumps
 * `lastUsedAt` (best-effort) and, for an activation-mode key on its FIRST use,
 * stamps `activatedAt` once (best-effort). A policy-less enabled key resolves to
 * `{ status:'ok', key:{ id } }` — byte-identical to the pre-policy result.
 */
export async function verifyKey(
  db: OutboundKeyDb,
  presentedKey: string | undefined,
  now: number = Date.now(),
): Promise<KeyVerification> {
  if (!presentedKey) return { status: 'invalid' };
  const trimmed = presentedKey.trim();
  if (!trimmed) return { status: 'invalid' };
  const row = await db.outboundApiKeysGetByHash(hashKey(trimmed));
  if (!row) return { status: 'invalid' };
  // Defensive re-check (the query already filters, but never trust a single
  // boolean in the auth path).
  if (!row.enabled || row.revokedAt !== null) return { status: 'invalid' };

  // Expiry / first-use activation (outbound-key-policy). A policy-less row is
  // never expired and never needs activation, so this is inert for it.
  const expiry = computeKeyExpiry(row, now);
  if (expiry.expired) return { status: 'expired' };

  void db.outboundApiKeysTouchLastUsed(row.id).catch(() => {
    /* last-used bookkeeping is best-effort */
  });
  // First successful use of an activation-mode key → stamp activation ONCE
  // (best-effort; `markActivated` is idempotent so a concurrent double-fire is
  // harmless).
  if (expiry.needsActivation) {
    void db.outboundApiKeysMarkActivated(row.id, now).catch(() => {
      /* activation stamp is best-effort */
    });
  }
  return { status: 'ok', key: toVerifiedKey(row) };
}

/**
 * Thin id-or-null wrapper over {@link verifyKey} for callers not ready for the
 * reason-bearing form: returns the `VerifiedKey` on success, `null` on any
 * invalid/expired key (the exact pre-policy contract).
 */
export async function verifyPresentedKey(
  db: OutboundKeyDb,
  presentedKey: string | undefined,
): Promise<VerifiedKey | null> {
  const result = await verifyKey(db, presentedKey);
  return result.status === 'ok' ? result.key : null;
}
