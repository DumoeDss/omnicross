/**
 * secrets-envelope.test.ts — the AES-256-GCM envelope codec + SecretBox tri-state
 * (secrets tasks 5.1, 5.2, 5.4).
 *
 * Covers: round-trip identity, random-IV (different ciphertext each encrypt),
 * `enc:v1:` format, tri-state passthrough ($ENV never encrypted / already-enc
 * not double-encrypted / legacy plaintext read passthrough), encryptMaybe /
 * decryptMaybe idempotence, and the wrong-key GCM auth-tag failure UX.
 */

import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decryptValue, encryptValue, ENVELOPE_PREFIX, isEnvelope, parseEnvelope } from '../secrets';
import { SecretBox } from '../secrets';

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);

describe('envelope codec (5.1)', () => {
  it('round-trips a plaintext byte-for-byte', () => {
    const env = encryptValue('sk-test-1234', KEY_A);
    expect(decryptValue(env, KEY_A)).toBe('sk-test-1234');
  });

  it('emits a well-formed enc:v1:<iv>:<tag>:<ciphertext> envelope', () => {
    const env = encryptValue('sk-test-1234', KEY_A);
    expect(env.startsWith('enc:v1:')).toBe(true);
    expect(isEnvelope(env)).toBe(true);
    const parts = env.split(':');
    expect(parts).toHaveLength(5);
    expect(`${parts[0]}:`).toBe(ENVELOPE_PREFIX);
    expect(parts[1]).toBe('v1');
    const parsed = parseEnvelope(env);
    expect(parsed.iv).toHaveLength(12);
    expect(parsed.tag).toHaveLength(16);
  });

  it('produces a DIFFERENT ciphertext each encrypt (random IV, no reuse)', () => {
    const a = encryptValue('same-plaintext', KEY_A);
    const b = encryptValue('same-plaintext', KEY_A);
    expect(a).not.toBe(b);
    expect(parseEnvelope(a).iv.equals(parseEnvelope(b).iv)).toBe(false);
    // Both still decrypt to the same plaintext.
    expect(decryptValue(a, KEY_A)).toBe('same-plaintext');
    expect(decryptValue(b, KEY_A)).toBe('same-plaintext');
  });

  it('round-trips unicode + empty + long values', () => {
    for (const v of ['', '🔐-secret-✓', 'x'.repeat(5000)]) {
      expect(decryptValue(encryptValue(v, KEY_A), KEY_A)).toBe(v);
    }
  });

  it('rejects a malformed envelope without leaking material', () => {
    expect(() => parseEnvelope('enc:v1:onlytwo')).toThrow(/malformed/);
    expect(() => parseEnvelope('enc:v2:aa:bb:cc')).toThrow(/version/);
  });
});

describe('SecretBox tri-state (5.2)', () => {
  const box = new SecretBox(KEY_A);

  it('encryptMaybe NEVER encrypts a $ENV reference', () => {
    expect(box.encryptMaybe('$OPENAI_KEY')).toBe('$OPENAI_KEY');
  });

  it('encryptMaybe does NOT double-encrypt an already-enc value', () => {
    const once = box.encryptMaybe('sk-literal');
    expect(isEnvelope(once)).toBe(true);
    const twice = box.encryptMaybe(once);
    expect(twice).toBe(once); // no enc:enc: nesting, byte-identical
  });

  it('encryptMaybe encrypts a legacy plaintext literal', () => {
    const out = box.encryptMaybe('sk-literal');
    expect(isEnvelope(out)).toBe(true);
    expect(box.decryptMaybe(out)).toBe('sk-literal');
  });

  it('decryptMaybe passes a $ENV reference + legacy plaintext through', () => {
    expect(box.decryptMaybe('$OPENAI_KEY')).toBe('$OPENAI_KEY');
    expect(box.decryptMaybe('sk-legacy-plain')).toBe('sk-legacy-plain');
  });

  it('decryptMaybe is idempotent on a non-envelope value', () => {
    expect(box.decryptMaybe(box.decryptMaybe('sk-legacy'))).toBe('sk-legacy');
  });

  it('encryptMaybe/decryptMaybe pass empty string through', () => {
    expect(box.encryptMaybe('')).toBe('');
    expect(box.decryptMaybe('')).toBe('');
  });
});

describe('wrong-key / tamper UX (5.4)', () => {
  it('decrypting with a DIFFERENT key throws a clear, secret-free error', () => {
    const env = encryptValue('sk-secret-value-zzz', KEY_A);
    const boxB = new SecretBox(KEY_B);
    let thrown: Error | undefined;
    try {
      boxB.decrypt(env);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/master key does not match|tampered/i);
    // The error must NOT echo the ciphertext or any key material.
    expect(thrown!.message).not.toContain(env);
    expect(thrown!.message).not.toContain('sk-secret-value-zzz');
    expect(thrown!.message).not.toContain(KEY_A.toString('base64'));
    expect(thrown!.message).not.toContain(KEY_B.toString('base64'));
  });

  it('a tampered ciphertext fails GCM verification', () => {
    const env = encryptValue('sk-secret', KEY_A);
    const parts = env.split(':');
    // Flip the last base64 char of the ciphertext segment.
    const ct = parts[4];
    parts[4] = ct.slice(0, -1) + (ct.endsWith('A') ? 'B' : 'A');
    const tampered = parts.join(':');
    const box = new SecretBox(KEY_A);
    expect(() => box.decrypt(tampered)).toThrow(/master key does not match|tampered/i);
  });

  it('SecretBox rejects a non-32-byte key', () => {
    expect(() => new SecretBox(randomBytes(16))).toThrow(/32-byte/);
  });
});
