/**
 * SecretBox.ts — a 32-byte master key wrapped with the tri-state secret rules
 * (secrets design D2/D7).
 *
 * `SecretBox` holds the resolved master key (never exposed) and applies the
 * tri-state discrimination on top of the pure `envelope.ts` codec:
 *
 *   `$`-prefix   → ENV indirection: ALWAYS plaintext, never encrypted (resolved
 *                  later by the pool's `resolveEnvKey`). Passthrough both ways.
 *   `enc:`       → ciphertext: decrypted on read, left as-is on write.
 *   else         → legacy plaintext: passed through on read, encrypted on write.
 *
 * `decryptMaybe` / `encryptMaybe` are the idempotent seam every read/write
 * accessor calls — applying either repeatedly never changes a correctly-typed
 * value (no `enc:enc:` nesting, no double-decrypt). `decrypt` wraps a GCM
 * auth-tag failure (wrong key / tampered envelope) into an actionable,
 * secret-free error — it NEVER echoes the key or the ciphertext.
 *
 * LAZY KEY (secrets design D3 — "首次需要时自动生成"): the constructor accepts
 * either a resolved 32-byte Buffer OR a `() => Buffer` resolver. The key is only
 * resolved on the FIRST `encrypt`/`decrypt` (then cached). The tri-state
 * passthroughs (`$ENV` / empty / non-envelope-on-read) return BEFORE the key is
 * touched — so a pure legacy-plaintext load that only passes values through
 * NEVER triggers key resolution, and therefore never auto-generates a keyfile.
 * A keyfile is materialized only when an `enc:` value must be decrypted or a
 * write must encrypt (the resolver does the lazy auto-gen).
 *
 * @module @omnicross/daemon/secrets/SecretBox
 */

import { decryptValue, encryptValue, isEnvelope } from './envelope';

/** A resolved master key, or a lazy resolver that produces one on first use. */
export type MasterKeyInput = Buffer | (() => Buffer);

/** A `$`-prefixed value is an ENV indirection reference — always plaintext. */
function isEnvRef(value: string): boolean {
  return value.startsWith('$');
}

export class SecretBox {
  /** The raw 32-byte master key (resolved lazily). Held privately; never logged. */
  private key: Buffer | null;
  /** The lazy resolver (used once, then nulled after caching the key). */
  private resolver: (() => Buffer) | null;

  constructor(key: MasterKeyInput) {
    if (typeof key === 'function') {
      this.key = null;
      this.resolver = key;
    } else {
      if (key.length !== 32) {
        throw new Error('SecretBox requires a 32-byte master key');
      }
      this.key = key;
      this.resolver = null;
    }
  }

  /** Resolve (and cache) the master key on first crypto use. Validates length. */
  private getKey(): Buffer {
    if (this.key) return this.key;
    if (!this.resolver) {
      throw new Error('SecretBox has no master key');
    }
    const resolved = this.resolver();
    if (resolved.length !== 32) {
      throw new Error('SecretBox requires a 32-byte master key');
    }
    this.key = resolved;
    this.resolver = null;
    return resolved;
  }

  /** Encrypt a plaintext value into a fresh `enc:v1:...` envelope (unconditional). */
  encrypt(plain: string): string {
    return encryptValue(plain, this.getKey());
  }

  /**
   * Decrypt an `enc:v1:...` envelope to plaintext. Wraps a GCM verification
   * failure (wrong master key or a tampered envelope) into a clear, actionable
   * error — the original crypto error (which carries no secret material) is
   * intentionally NOT re-surfaced verbatim and the ciphertext/key are never
   * placed in the message.
   */
  decrypt(envelope: string): string {
    try {
      return decryptValue(envelope, this.getKey());
    } catch {
      throw new Error(
        'failed to decrypt a stored secret: the master key does not match (wrong ' +
          `${'OMNICROSS_MASTER_KEY'} / master.key) or the encrypted value was tampered with`,
      );
    }
  }

  /**
   * READ-direction tri-state: decrypt an `enc:` envelope; pass a `$ENV`
   * reference or legacy plaintext through unchanged. Idempotent on any
   * non-envelope value.
   */
  decryptMaybe(value: string): string {
    if (!value) return value;
    if (isEnvRef(value)) return value;
    if (isEnvelope(value)) return this.decrypt(value);
    return value;
  }

  /**
   * WRITE-direction tri-state: encrypt legacy plaintext; pass a `$ENV` reference
   * (never encrypt indirection) or an already-`enc:` envelope (no `enc:enc:`
   * nesting) through unchanged. Idempotent — re-applying never re-encrypts.
   */
  encryptMaybe(value: string): string {
    if (!value) return value;
    if (isEnvRef(value)) return value;
    if (isEnvelope(value)) return value;
    return this.encrypt(value);
  }
}
