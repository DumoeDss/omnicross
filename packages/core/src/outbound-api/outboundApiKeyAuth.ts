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

import type { OutboundApiKeyCreated, OutboundKeyDb } from './types';

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
function randomBase62(count: number): string {
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

/** The id of a verified key (for rate-limiting + last-used bookkeeping). */
export interface VerifiedKey {
  id: string;
  /**
   * The key's per-key concurrency ceiling, carried from the row so the wire
   * layer keys the concurrency gate without a second DB read. Absent/`0` =
   * unlimited (gate bypassed).
   */
  maxConcurrency?: number;
}

/**
 * Verify a presented key against the DB. Matches by hash where the stored row
 * is enabled AND not revoked (the DB query enforces this). On success bumps
 * `lastUsedAt` (best-effort, fire-and-forget) and returns the key id; returns
 * `null` on any miss / disabled / revoked key.
 */
export async function verifyPresentedKey(
  db: OutboundKeyDb,
  presentedKey: string | undefined,
): Promise<VerifiedKey | null> {
  if (!presentedKey) return null;
  const trimmed = presentedKey.trim();
  if (!trimmed) return null;
  const row = await db.outboundApiKeysGetByHash(hashKey(trimmed));
  if (!row) return null;
  // Defensive re-check (the query already filters, but never trust a single
  // boolean in the auth path).
  if (!row.enabled || row.revokedAt !== null) return null;
  void db.outboundApiKeysTouchLastUsed(row.id).catch(() => {
    /* last-used bookkeeping is best-effort */
  });
  // Carry the concurrency ceiling through when the row has one (absent otherwise
  // so the wire layer bypasses the gate for unlimited keys).
  return row.maxConcurrency !== undefined && row.maxConcurrency !== null
    ? { id: row.id, maxConcurrency: row.maxConcurrency }
    : { id: row.id };
}
