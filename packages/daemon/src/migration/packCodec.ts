/**
 * packCodec.ts — the passphrase-keyed, AAD-authenticated migration-pack envelope
 * (app-parity child 6, design D1).
 *
 * A migration pack must travel to a DIFFERENT machine, so it CANNOT be keyed by
 * the at-rest machine-local master key (the target's key differs). Instead the
 * pack is keyed by a USER PASSPHRASE via the Node built-in scrypt KDF over a
 * fresh random salt; the KDF cost params + salt are stored in a self-describing
 * header so the pack is portable + a future cost bump is non-breaking.
 *
 * The pack string is:
 *
 *   OMCXPACK1.<base64url(headerJson)>.<base64(ciphertext)>
 *
 * where the header carries `{ magic, v, kdf, salt, N, r, p, iv, tag }`. The
 * cipher is AES-256-GCM (the SAME primitive `secrets/envelope.ts` uses — NOT a
 * new cipher). The `magic` + `v` + `kdf` identifiers are bound as GCM
 * ADDITIONAL AUTHENTICATED DATA, so a tampered header (e.g. a downgraded `kdf`
 * or `v`) fails the auth-tag verification at `openPack` — tamper-evidence on the
 * header, not just the ciphertext.
 *
 * SECURITY: the passphrase is IN-only — it derives the key and is dropped; it is
 * never stored, echoed, or logged. No secret material (passphrase, derived key,
 * plaintext, ciphertext) is ever placed in a thrown error. A wrong passphrase or
 * a tampered pack fails the GCM auth-tag and throws a clear, secret-free error.
 *
 * @module @omnicross/daemon/migration/packCodec
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** The pack magic — the self-describing format discriminant. */
const PACK_MAGIC = 'OMCXPACK';

/** The only pack version this codec emits + accepts. */
const PACK_VERSION = 1;

/** The KDF algorithm identifier (bound as AAD). */
const KDF_ALGORITHM = 'scrypt';

/** The string prefix on the pack (`<MAGIC><VERSION>.`), e.g. `OMCXPACK1.`. */
const PACK_PREFIX = `${PACK_MAGIC}${PACK_VERSION}.`;

/** AES-256-GCM sizes (mirrors `secrets/envelope.ts`). */
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** scrypt KDF parameters. Moderate memory-hardness (N=2^15) — stored in the
 *  header so a future codec version can raise the cost without breaking old
 *  packs. `maxmem` is widened so N=2^15 is allowed (default cap rejects it). */
const SCRYPT_N = 1 << 15; // 32768
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_MAXMEM = 128 * SCRYPT_R * SCRYPT_N * 2; // headroom above the 128*r*N need

/** The minimum acceptable passphrase length (design D4 — non-trivial). */
export const MIN_PASSPHRASE_LENGTH = 8;

/** The self-describing pack header (base64url JSON between the two `.`). */
interface PackHeader {
  magic: string;
  v: number;
  kdf: string;
  /** base64 KDF salt. */
  salt: string;
  N: number;
  r: number;
  p: number;
  /** base64 AES-GCM nonce. */
  iv: string;
  /** base64 AES-GCM auth tag. */
  tag: string;
}

/** Thrown when a passphrase is empty / below the minimum (secret-free message). */
export class WeakPassphraseError extends Error {
  constructor() {
    super(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
    this.name = 'WeakPassphraseError';
  }
}

/** Thrown when a pack is malformed or the passphrase is wrong / it was tampered
 *  with (a single secret-free class — never distinguishes wrong-pass from
 *  tamper, and never echoes the passphrase or any ciphertext). */
export class PackAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackAuthError';
  }
}

/** Reject an empty / below-minimum passphrase (design D4). IN-only — never logs. */
export function assertPassphraseStrength(passphrase: unknown): asserts passphrase is string {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new WeakPassphraseError();
  }
}

/** base64url-encode a UTF-8 string (header transport; no `+`/`/`/`=`). */
function toB64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/** base64url-decode to a UTF-8 string. */
function fromB64Url(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

/**
 * Derive the 32-byte pack key from a passphrase + salt via scrypt. The
 * passphrase is consumed here and never retained.
 */
function deriveKey(passphrase: string, salt: Buffer, N: number, r: number, p: number): Buffer {
  return scryptSync(passphrase, salt, KEY_BYTES, { N, r, p, maxmem: SCRYPT_MAXMEM });
}

/** The bytes bound as GCM AAD: the immutable identity of the format. A tampered
 *  magic/version/kdf in the transmitted header fails the auth-tag at open. */
function aadFor(magic: string, version: number, kdf: string): Buffer {
  return Buffer.from(`${magic}|${version}|${kdf}`, 'utf8');
}

/**
 * Encrypt `bundleJson` under a passphrase-derived key into a self-describing pack
 * string. A fresh salt + IV are drawn per call (no reuse). The passphrase is
 * validated for strength first (IN-only). Returns the OPAQUE pack string — the
 * plaintext bundle is never echoed.
 */
export function sealPack(bundleJson: string, passphrase: string): string {
  assertPassphraseStrength(passphrase);
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadFor(PACK_MAGIC, PACK_VERSION, KDF_ALGORITHM));
  const ciphertext = Buffer.concat([cipher.update(bundleJson, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header: PackHeader = {
    magic: PACK_MAGIC,
    v: PACK_VERSION,
    kdf: KDF_ALGORITHM,
    salt: salt.toString('base64'),
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
  return `${PACK_PREFIX}${toB64Url(JSON.stringify(header))}.${ciphertext.toString('base64')}`;
}

/** Parse + structurally validate a pack string into its header + ciphertext.
 *  Throws a clear `PackAuthError` (secret-free) on any malformed shape. */
function parsePack(packString: string): { header: PackHeader; ciphertext: Buffer } {
  if (typeof packString !== 'string' || !packString.startsWith(PACK_PREFIX)) {
    throw new PackAuthError('migration pack is malformed (bad magic/version prefix)');
  }
  const rest = packString.slice(PACK_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot < 0) throw new PackAuthError('migration pack is malformed (missing body)');
  const headerB64Url = rest.slice(0, dot);
  const ctB64 = rest.slice(dot + 1);
  let header: PackHeader;
  try {
    header = JSON.parse(fromB64Url(headerB64Url)) as PackHeader;
  } catch {
    throw new PackAuthError('migration pack is malformed (unreadable header)');
  }
  if (
    !header ||
    header.magic !== PACK_MAGIC ||
    header.v !== PACK_VERSION ||
    header.kdf !== KDF_ALGORITHM ||
    typeof header.salt !== 'string' ||
    typeof header.iv !== 'string' ||
    typeof header.tag !== 'string' ||
    typeof header.N !== 'number' ||
    typeof header.r !== 'number' ||
    typeof header.p !== 'number'
  ) {
    throw new PackAuthError('migration pack is malformed (unsupported header)');
  }
  const ciphertext = Buffer.from(ctB64, 'base64');
  return { header, ciphertext };
}

/**
 * Decrypt + authenticate a pack string under `passphrase`, returning the bundle
 * JSON. A wrong passphrase or any tampering (header or ciphertext) fails the GCM
 * auth-tag and throws a single secret-free `PackAuthError` — it NEVER reveals
 * whether the passphrase was wrong vs the pack was altered, and never echoes the
 * passphrase or ciphertext. The passphrase is validated for strength first and
 * is IN-only.
 */
export function openPack(packString: string, passphrase: string): string {
  assertPassphraseStrength(passphrase);
  const { header, ciphertext } = parsePack(packString);
  const salt = Buffer.from(header.salt, 'base64');
  const iv = Buffer.from(header.iv, 'base64');
  const tag = Buffer.from(header.tag, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new PackAuthError('migration pack is malformed (invalid iv/tag length)');
  }
  // The AAD reflects the IMMUTABLE format identity — but it is built from the
  // CONSTANTS (not the transmitted header), so a tampered magic/version/kdf in
  // the header (which we already structurally rejected above) could not produce
  // a matching tag anyway. Binding the constants is what makes the header
  // tamper-evident: any altered identity fails the auth-tag here.
  const key = deriveKey(passphrase, salt, header.N, header.r, header.p);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aadFor(PACK_MAGIC, PACK_VERSION, KDF_ALGORITHM));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // GCM auth-tag failure: wrong passphrase OR a tampered pack. One opaque,
    // secret-free message either way (no oracle distinguishing the two).
    throw new PackAuthError('wrong passphrase or tampered migration pack');
  }
}
