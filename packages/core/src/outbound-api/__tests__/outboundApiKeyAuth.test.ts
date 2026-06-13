/**
 * Unit tests for outbound API key generation / hashing / verification
 * (`outbound-api-server` task 8.2). Pure logic against an in-memory stub DB.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createNamedKey,
  generateSecret,
  hashKey,
  keyPrefix,
  verifyPresentedKey,
} from '../outboundApiKeyAuth';
import type { OutboundKeyDb, OutboundKeyDbRow } from '../types';

/** A tiny in-memory OutboundKeyDb stub. */
function makeStubDb(rows: OutboundKeyDbRow[] = []): OutboundKeyDb & { rows: OutboundKeyDbRow[] } {
  const store = [...rows];
  return {
    rows: store,
    outboundApiKeysList: async () => [...store],
    outboundApiKeysGetByHash: async (hash) =>
      store.find((r) => r.keyHash === hash && r.enabled && r.revokedAt === null) ?? null,
    outboundApiKeysCreate: async (input) => {
      const row: OutboundKeyDbRow = {
        id: input.id,
        name: input.name,
        keyHash: input.keyHash,
        keyPrefix: input.keyPrefix,
        enabled: true,
        createdAt: input.createdAt ?? Date.now(),
        lastUsedAt: null,
        revokedAt: null,
      };
      store.push(row);
      return row;
    },
    outboundApiKeysRevoke: async (id) => {
      const row = store.find((r) => r.id === id);
      if (!row) return false;
      row.revokedAt = Date.now();
      row.enabled = false;
      return true;
    },
    outboundApiKeysTouchLastUsed: async (id) => {
      const row = store.find((r) => r.id === id);
      if (!row) return false;
      row.lastUsedAt = Date.now();
      return true;
    },
    outboundApiKeysSetEnabled: async (id, enabled) => {
      const row = store.find((r) => r.id === id);
      if (!row) return false;
      row.enabled = enabled;
      return true;
    },
  };
}

describe('outboundApiKeyAuth', () => {
  it('generates a sk-omnicross-<base62> secret with a stable prefix', () => {
    const secret = generateSecret();
    expect(secret.startsWith('sk-omnicross-')).toBe(true);
    expect(secret.length).toBeGreaterThan('sk-omnicross-'.length + 20);
    expect(keyPrefix(secret)).toBe(secret.slice(0, 14));
  });

  it('hashKey is stable and deterministic', () => {
    const secret = 'sk-omnicross-abc123';
    expect(hashKey(secret)).toBe(hashKey(secret));
    expect(hashKey(secret)).not.toBe(hashKey('sk-omnicross-other'));
    expect(hashKey(secret)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('createNamedKey persists only the hash + prefix and reveals plaintext once', async () => {
    const db = makeStubDb();
    const created = await createNamedKey(db, 'My laptop');
    expect(created.name).toBe('My laptop');
    expect(created.plaintextOnce.startsWith('sk-omnicross-')).toBe(true);
    expect(db.rows).toHaveLength(1);
    // The stored row carries the hash, never the plaintext.
    expect(db.rows[0].keyHash).toBe(hashKey(created.plaintextOnce));
    expect(db.rows[0].keyHash).not.toBe(created.plaintextOnce);
    expect(db.rows[0].keyPrefix).toBe(created.keyPrefix);
  });

  it('verify accepts an enabled key and bumps lastUsedAt', async () => {
    const db = makeStubDb();
    const created = await createNamedKey(db, 'k1');
    const touchSpy = vi.spyOn(db, 'outboundApiKeysTouchLastUsed');
    const verified = await verifyPresentedKey(db, created.plaintextOnce);
    expect(verified).not.toBeNull();
    expect(verified?.id).toBe(created.id);
    expect(touchSpy).toHaveBeenCalledWith(created.id);
  });

  it('verify rejects missing / unknown / disabled / revoked keys', async () => {
    const db = makeStubDb();
    const created = await createNamedKey(db, 'k1');

    expect(await verifyPresentedKey(db, undefined)).toBeNull();
    expect(await verifyPresentedKey(db, '')).toBeNull();
    expect(await verifyPresentedKey(db, 'sk-omnicross-unknown')).toBeNull();

    // Disabled.
    await db.outboundApiKeysSetEnabled(created.id, false);
    expect(await verifyPresentedKey(db, created.plaintextOnce)).toBeNull();

    // Re-enable then revoke.
    await db.outboundApiKeysSetEnabled(created.id, true);
    await db.outboundApiKeysRevoke(created.id);
    expect(await verifyPresentedKey(db, created.plaintextOnce)).toBeNull();
  });
});
