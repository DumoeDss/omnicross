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
  verifyKey,
  verifyPresentedKey,
} from '../outboundApiKeyAuth';
import type { OutboundKeyDb, OutboundKeyDbRow } from '../types';

const DAY_MS = 86_400_000;

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
    outboundApiKeysSetMaxConcurrency: async (id, maxConcurrency) => {
      const row = store.find((r) => r.id === id);
      if (!row || row.revokedAt !== null) return false;
      if (maxConcurrency === null) delete row.maxConcurrency;
      else row.maxConcurrency = maxConcurrency;
      return true;
    },
    outboundApiKeysSetPolicy: async (id, policy) => {
      const row = store.find((r) => r.id === id);
      if (!row || row.revokedAt !== null) return false;
      Object.assign(row, policy);
      return true;
    },
    outboundApiKeysMarkActivated: async (id, activatedAt) => {
      const row = store.find((r) => r.id === id);
      if (!row || row.revokedAt !== null || row.activatedAt != null) return false;
      row.activatedAt = activatedAt;
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

  it('carries maxConcurrency through verify when the row has one, absent otherwise', async () => {
    const db = makeStubDb();
    const created = await createNamedKey(db, 'capped');

    // No ceiling set → the verified key omits maxConcurrency.
    const before = await verifyPresentedKey(db, created.plaintextOnce);
    expect(before).not.toBeNull();
    expect(before?.maxConcurrency).toBeUndefined();

    // Set a ceiling → verify carries it.
    await db.outboundApiKeysSetMaxConcurrency(created.id, 3);
    const after = await verifyPresentedKey(db, created.plaintextOnce);
    expect(after?.maxConcurrency).toBe(3);

    // Clear it (null) → back to absent.
    await db.outboundApiKeysSetMaxConcurrency(created.id, null);
    const cleared = await verifyPresentedKey(db, created.plaintextOnce);
    expect(cleared?.maxConcurrency).toBeUndefined();
  });
});

describe('verifyKey — expiry + activation (outbound-key-policy)', () => {
  it('a policy-less key resolves ok with a byte-identical {id} verified key', async () => {
    const db = makeStubDb();
    const created = await createNamedKey(db, 'plain');
    const res = await verifyKey(db, created.plaintextOnce);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.key).toEqual({ id: created.id });
    expect(res.key.costLimits).toBeUndefined();
    expect(res.key.rateLimit).toBeUndefined();
  });

  it('a fixed key past expiresAt is expired', async () => {
    const db = makeStubDb();
    const created = await createNamedKey(db, 'exp');
    await db.outboundApiKeysSetPolicy(created.id, { expiresAt: 1_000 });
    expect((await verifyKey(db, created.plaintextOnce, 2_000)).status).toBe('expired');
    // Still valid strictly before its expiry.
    expect((await verifyKey(db, created.plaintextOnce, 500)).status).toBe('ok');
  });

  it('an activation-mode key activates on first use and stamps activatedAt once', async () => {
    const db = makeStubDb();
    const created = await createNamedKey(db, 'act');
    await db.outboundApiKeysSetPolicy(created.id, { activationMode: 'activation', activationDays: 30 });
    const spy = vi.spyOn(db, 'outboundApiKeysMarkActivated');

    // First use: not expired, activation fired.
    const first = await verifyKey(db, created.plaintextOnce, 10_000);
    expect(first.status).toBe('ok');
    // Best-effort activation is fire-and-forget; let the microtask settle.
    await Promise.resolve();
    expect(spy).toHaveBeenCalledWith(created.id, 10_000);
    const row = db.rows.find((r) => r.id === created.id);
    expect(row?.activatedAt).toBe(10_000);

    // Second use much later within the window: still ok, activatedAt unchanged.
    const second = await verifyKey(db, created.plaintextOnce, 10_000 + 5 * DAY_MS);
    expect(second.status).toBe('ok');
    expect(row?.activatedAt).toBe(10_000);
  });

  it('an activation-mode key past its window is expired', async () => {
    const db = makeStubDb();
    const created = await createNamedKey(db, 'act2');
    await db.outboundApiKeysSetPolicy(created.id, {
      activationMode: 'activation',
      activationDays: 7,
    });
    // Simulate a prior activation.
    await db.outboundApiKeysMarkActivated(created.id, 1_000);
    expect((await verifyKey(db, created.plaintextOnce, 1_000 + 8 * DAY_MS)).status).toBe('expired');
    expect((await verifyKey(db, created.plaintextOnce, 1_000 + 3 * DAY_MS)).status).toBe('ok');
  });

  it('carries cost limits + rate override through the verified key', async () => {
    const db = makeStubDb();
    const created = await createNamedKey(db, 'quota');
    await db.outboundApiKeysSetPolicy(created.id, {
      dailyCostLimitUsd: 5,
      totalCostLimitUsd: 100,
      rateLimitMaxRequests: 10,
      rateLimitWindowMs: 1_000,
    });
    const res = await verifyKey(db, created.plaintextOnce);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.key.costLimits).toEqual({ dailyUsd: 5, totalUsd: 100 });
    expect(res.key.rateLimit).toEqual({ maxRequests: 10, windowMs: 1_000 });
  });
});
