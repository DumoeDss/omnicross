/**
 * envelope.ts — the AES-256-GCM secret envelope codec (secrets design D2).
 *
 * A single secret VALUE is encrypted into a versioned, single-line envelope
 * string that drops straight into a JSON `string` field (so per-VALUE encryption
 * never breaks `config.json`'s shape-guards — an `enc:` string still satisfies
 * `typeof === 'string'`). The format is:
 *
 *   enc:v1:<base64 iv>:<base64 tag>:<base64 ciphertext>
 *
 * — `enc:` prefix is the tri-state discriminant (vs `$ENV` indirection / legacy
 * plaintext, design D2), `v1` lets a future cipher/KDF change be recognized
 * (rotate's precondition), and AES-256-GCM gives authenticated encryption: a
 * wrong key or a tampered envelope fails the auth-tag verification at decrypt
 * time (a clear "wrong-key" UX rather than silent garbage). Each encrypt uses a
 * FRESH random 12-byte IV (never reused) + the 16-byte GCM tag.
 *
 * These are PURE functions over a raw 32-byte key Buffer; the stateful
 * `SecretBox` (`SecretBox.ts`) wraps them with the tri-state passthrough rules.
 * No secret material (key bytes, ciphertext, plaintext) is ever placed in an
 * error message thrown here.
 *
 * @module @omnicross/daemon/secrets/envelope
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** The envelope prefix (also the tri-state discriminant for ciphertext). */
export const ENVELOPE_PREFIX = 'enc:';

/** The only envelope version this codec emits + accepts. */
const ENVELOPE_VERSION = 'v1';

/** AES-256-GCM: 32-byte key, 12-byte (96-bit) IV, 16-byte auth tag. */
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The parsed parts of a `enc:v1:<iv>:<tag>:<ciphertext>` envelope. */
export interface ParsedEnvelope {
  version: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

/** Whether `s` is a (prefix-matching) secret envelope — the tri-state ciphertext
 *  discriminant. Does NOT validate the body (use `parseEnvelope` for that). */
export function isEnvelope(s: string): boolean {
  return s.startsWith(ENVELOPE_PREFIX);
}

/**
 * Parse an `enc:v1:<iv>:<tag>:<ciphertext>` string into its raw parts. Throws a
 * clear (secret-free) error when the shape is wrong. Splits into exactly 5
 * segments (`enc`, `v1`, iv, tag, ciphertext); a base64 with internal `:` is
 * impossible (base64 alphabet has no `:`), so a fixed split is safe.
 */
export function parseEnvelope(envelope: string): ParsedEnvelope {
  const parts = envelope.split(':');
  if (parts.length !== 5 || `${parts[0]}:` !== ENVELOPE_PREFIX) {
    throw new Error('secret envelope is malformed (expected enc:v1:<iv>:<tag>:<ciphertext>)');
  }
  const [, version, ivB64, tagB64, ctB64] = parts;
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`unsupported secret envelope version '${version}' (expected ${ENVELOPE_VERSION})`);
  }
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('secret envelope has an invalid iv/tag length');
  }
  return { version, iv, tag, ciphertext };
}

/**
 * Encrypt `plain` with the 32-byte `key` into a fresh `enc:v1:...` envelope.
 * A new random IV is drawn on EVERY call (so the same plaintext yields a
 * different envelope each time — no IV reuse).
 */
export function encryptValue(plain: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`secret key must be ${KEY_BYTES} bytes`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_PREFIX.slice(0, -1), // 'enc' (prefix without its trailing ':')
    ENVELOPE_VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * Decrypt an `enc:v1:...` envelope with the 32-byte `key`, returning the
 * original plaintext. A wrong key or a tampered envelope fails GCM auth-tag
 * verification and throws (the caller — `SecretBox.decrypt` — wraps it into an
 * actionable, secret-free "wrong master key or tampered" message). This raw fn
 * deliberately surfaces the underlying crypto error WITHOUT echoing the key or
 * ciphertext.
 */
export function decryptValue(envelope: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`secret key must be ${KEY_BYTES} bytes`);
  }
  const { iv, tag, ciphertext } = parseEnvelope(envelope);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}
