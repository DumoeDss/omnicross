/**
 * masterKey.ts — the daemon's 32-byte master-key resolver (secrets design D3).
 *
 * Resolution order (env override beats keyfile; keyfile auto-generates last):
 *  1. `OMNICROSS_MASTER_KEY` env (highest) — present + non-empty → decode it as
 *     64 hex chars OR base64 to exactly 32 bytes; an invalid length fails FAST
 *     (never encrypt with half a key). NOT written to disk (container/CI inject
 *     without baking a secret into an image layer).
 *  2. keyfile (default `~/.omnicross/master.key`, NOT a config.json sibling so a
 *     copied/committed config never drags the key along — design D3) — exists →
 *     read its raw/encoded 32 bytes.
 *  3. else AUTO-GENERATE `randomBytes(32)`, write it `0600`, and use it (so an
 *     unattended bare-metal boot works with no preset key). The keyfile is only
 *     materialized when the resolver is actually invoked for a key — a pure
 *     legacy-plaintext path that never needs encryption never triggers a write
 *     (the caller decides WHEN to resolve; see config.ts `setSecretBox`).
 *
 * Windows note (design D8): `chmod 0600` is effectively a no-op on win32 (NTFS
 * ACLs don't map POSIX mode). We still call it (harmless), do NOT branch on
 * platform, and document the honest caveat in user/04 (icacls / protected
 * profile dir).
 *
 * No secret material (key bytes) is ever logged or placed in an error message.
 *
 * @module @omnicross/daemon/secrets/masterKey
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The env var that, when set + non-empty, overrides the keyfile (highest priority). */
export const MASTER_KEY_ENV = 'OMNICROSS_MASTER_KEY';

/** AES-256 key length. */
const KEY_BYTES = 32;

/** The default keyfile path — a USER-PRIVATE dir, deliberately NOT next to
 *  config.json (design D3). */
export function defaultMasterKeyPath(): string {
  return join(homedir(), '.omnicross', 'master.key');
}

/** Options controlling master-key resolution (all optional → all defaults). */
export interface ResolveMasterKeyOptions {
  /** Override the env var value (tests/explicit); defaults to `process.env[MASTER_KEY_ENV]`. */
  envVar?: string | undefined;
  /** Override the keyfile path (the `--master-key-file` flag); defaults to `defaultMasterKeyPath()`. */
  keyFilePath?: string | undefined;
}

/**
 * Decode an `OMNICROSS_MASTER_KEY` env value to exactly 32 bytes: 64 hex chars →
 * hex-decode; else base64-decode. An invalid length fails fast with a clear,
 * secret-free error (no key material echoed).
 */
function decodeEnvKey(raw: string): Buffer {
  const trimmed = raw.trim();
  // 64 hex chars → 32 bytes (the canonical literal form).
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  // Otherwise treat it as base64 (32 bytes → 44 base64 chars incl padding).
  const buf = Buffer.from(trimmed, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `${MASTER_KEY_ENV} is invalid: expected 64 hex chars or base64 decoding to ${KEY_BYTES} bytes`,
    );
  }
  return buf;
}

/**
 * Read a keyfile's bytes, accepting either a raw 32-byte file OR a text file
 * holding 64 hex chars / base64 (so a keyfile authored by hand or by us both
 * load). Fails fast on a wrong length (secret-free message).
 */
function readKeyFile(path: string): Buffer {
  const raw = readFileSync(path);
  if (raw.length === KEY_BYTES) return raw; // raw 32-byte file (what we write)
  const text = raw.toString('utf8').trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  const b64 = Buffer.from(text, 'base64');
  if (b64.length === KEY_BYTES) return b64;
  throw new Error(
    `master key file '${path}' is invalid: expected 32 raw bytes, 64 hex chars, or 32-byte base64`,
  );
}

/** Auto-generate a fresh 32-byte key, write it `0600` (mkdir parent), and return it. */
function generateKeyFile(path: string): Buffer {
  const key = randomBytes(KEY_BYTES);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key, { mode: 0o600 });
  // Belt-and-suspenders: writeFileSync's mode is masked by umask on some
  // systems, so chmod again. No-op on win32 (design D8) — never throws here.
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore — non-POSIX filesystems may reject chmod; the write itself succeeded.
  }
  return key;
}

/**
 * Resolve the 32-byte master key per design D3 (env → keyfile → auto-generate).
 * Returns the raw key Buffer. The keyfile is only generated/written on path 3.
 */
export function resolveMasterKey(options: ResolveMasterKeyOptions = {}): Buffer {
  const envRaw = options.envVar ?? process.env[MASTER_KEY_ENV];
  if (typeof envRaw === 'string' && envRaw.trim().length > 0) {
    return decodeEnvKey(envRaw); // highest priority; NOT written to disk
  }

  const keyFilePath = options.keyFilePath ?? defaultMasterKeyPath();
  if (existsSync(keyFilePath)) {
    return readKeyFile(keyFilePath);
  }

  return generateKeyFile(keyFilePath);
}
