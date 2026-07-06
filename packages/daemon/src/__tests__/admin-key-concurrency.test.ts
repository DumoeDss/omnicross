/**
 * admin-key-concurrency.test.ts — per-key concurrency-limit persistence + the
 * `POST /admin/api/keys/:id/max-concurrency` admin route (`omnicross-uqc-daemon`,
 * capability `outbound-key-concurrency-admin`).
 *
 * Covers:
 *  - `JsonOutboundKeyDb.outboundApiKeysSetMaxConcurrency` (set / null-clear /
 *    revoked-refused), asserted through a file round-trip.
 *  - The max-concurrency route: valid set (200), null clear, out-of-range 400
 *    (nothing persisted), unknown id 404.
 *  - The keys-list DTO carries `maxConcurrency` and NEVER leaks `keyHash` or the
 *    one-time plaintext secret (no-secret-leak scan).
 *
 * The route tests boot the FULL daemon in process (mirrors
 * admin-server-kind-config.test.ts); the port test drives `JsonOutboundKeyDb`
 * directly.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';
import { JsonOutboundKeyDb } from '../ports/JsonOutboundKeyDb';

// ── Admin fetch helper ────────────────────────────────────────────────────────

let adminBase: string;

async function adminFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; json: unknown }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${adminBase}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

// ── Fixture ───────────────────────────────────────────────────────────────────

let tmpDir: string;
let daemon: Daemon;

async function bootDaemon(): Promise<void> {
  resetDaemonSingletonsForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-keyconc-'));
  const configPath = join(tmpDir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        providers: [
          { id: 'a', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-a', models: ['mock-model'] },
        ],
        server: { enabled: false, networkBinding: false, port: 0, endpoints: [] },
        admin: { port: 0 },
      },
      null,
      2,
    ),
    'utf8',
  );
  const config = loadConfig(configPath);
  daemon = buildDaemon(config, {
    configPath,
    keysPath: join(tmpDir, 'keys.json'),
    tokensPath: join(tmpDir, 'tokens.json'),
    masterKeyFilePath: join(tmpDir, 'master.key'),
  });
  await daemon.llmConfig.ready();
  await daemon.adminServer.start();
  adminBase = daemon.adminServer.getStatus().url as string;
}

afterEach(async () => {
  if (daemon) {
    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    daemon.apiKeyPool.dispose();
  }
  resetDaemonSingletonsForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ── Port: JsonOutboundKeyDb.outboundApiKeysSetMaxConcurrency ─────────────────────

describe('JsonOutboundKeyDb.outboundApiKeysSetMaxConcurrency', () => {
  it('sets, then clears, a key limit (round-trips through the file)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-keydb-'));
    try {
      const keysPath = join(dir, 'keys.json');
      const db = new JsonOutboundKeyDb(keysPath);
      const row = await db.outboundApiKeysCreate({
        id: 'k1',
        name: 'k1',
        keyHash: 'hash-1',
        keyPrefix: 'sk-omnicross-abcd',
      });
      expect(row.maxConcurrency).toBeUndefined();

      // Set → persisted, visible from a FRESH instance (proves it hit the file).
      expect(await db.outboundApiKeysSetMaxConcurrency('k1', 5)).toBe(true);
      const afterSet = (await new JsonOutboundKeyDb(keysPath).outboundApiKeysList())[0];
      expect(afterSet.maxConcurrency).toBe(5);

      // Clear (null) → field absent on round-trip (unlimited).
      expect(await db.outboundApiKeysSetMaxConcurrency('k1', null)).toBe(true);
      const afterClear = (await new JsonOutboundKeyDb(keysPath).outboundApiKeysList())[0];
      expect('maxConcurrency' in afterClear).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a revoked key and leaves it unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-keydb-'));
    try {
      const keysPath = join(dir, 'keys.json');
      const db = new JsonOutboundKeyDb(keysPath);
      await db.outboundApiKeysCreate({ id: 'k1', name: 'k1', keyHash: 'h', keyPrefix: 'p' });
      await db.outboundApiKeysSetMaxConcurrency('k1', 3);
      await db.outboundApiKeysRevoke('k1');

      expect(await db.outboundApiKeysSetMaxConcurrency('k1', 9)).toBe(false);
      const row = (await new JsonOutboundKeyDb(keysPath).outboundApiKeysList())[0];
      expect(row.maxConcurrency).toBe(3); // unchanged
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false for an unknown id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-keydb-'));
    try {
      const db = new JsonOutboundKeyDb(join(dir, 'keys.json'));
      expect(await db.outboundApiKeysSetMaxConcurrency('nope', 5)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Port: JsonOutboundKeyDb policy (outbound-key-policy) ─────────────────────────

describe('JsonOutboundKeyDb.outboundApiKeysSetPolicy + markActivated', () => {
  it('sets policy fields three-way and round-trips through the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-keydb-'));
    try {
      const keysPath = join(dir, 'keys.json');
      const db = new JsonOutboundKeyDb(keysPath);
      await db.outboundApiKeysCreate({ id: 'k1', name: 'k1', keyHash: 'h', keyPrefix: 'p' });

      expect(
        await db.outboundApiKeysSetPolicy('k1', {
          activationMode: 'activation',
          activationDays: 30,
          dailyCostLimitUsd: 5,
          rateLimitMaxRequests: 10,
        }),
      ).toBe(true);
      const set = (await new JsonOutboundKeyDb(keysPath).outboundApiKeysList())[0];
      expect(set.activationMode).toBe('activation');
      expect(set.activationDays).toBe(30);
      expect(set.dailyCostLimitUsd).toBe(5);
      expect(set.rateLimitMaxRequests).toBe(10);

      // null clears; omitted keeps (dailyCostLimitUsd not sent → retained).
      await db.outboundApiKeysSetPolicy('k1', { activationDays: null });
      const cleared = (await new JsonOutboundKeyDb(keysPath).outboundApiKeysList())[0];
      expect('activationDays' in cleared).toBe(false);
      expect(cleared.dailyCostLimitUsd).toBe(5); // kept
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('markActivated stamps once and is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-keydb-'));
    try {
      const keysPath = join(dir, 'keys.json');
      const db = new JsonOutboundKeyDb(keysPath);
      await db.outboundApiKeysCreate({ id: 'k1', name: 'k1', keyHash: 'h', keyPrefix: 'p' });

      expect(await db.outboundApiKeysMarkActivated('k1', 1_000)).toBe(true);
      // Second call is a no-op — the original stamp is never overwritten.
      expect(await db.outboundApiKeysMarkActivated('k1', 2_000)).toBe(false);
      const row = (await new JsonOutboundKeyDb(keysPath).outboundApiKeysList())[0];
      expect(row.activatedAt).toBe(1_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses policy writes on a revoked key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-keydb-'));
    try {
      const keysPath = join(dir, 'keys.json');
      const db = new JsonOutboundKeyDb(keysPath);
      await db.outboundApiKeysCreate({ id: 'k1', name: 'k1', keyHash: 'h', keyPrefix: 'p' });
      await db.outboundApiKeysRevoke('k1');
      expect(await db.outboundApiKeysSetPolicy('k1', { dailyCostLimitUsd: 9 })).toBe(false);
      expect(await db.outboundApiKeysMarkActivated('k1', 1_000)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Route: POST /admin/api/keys/:id/max-concurrency ─────────────────────────────

interface KeyInfo {
  id: string;
  maxConcurrency?: number;
}

async function createKey(): Promise<{ id: string; plaintext: string }> {
  const r = await adminFetch('POST', '/admin/api/keys', { name: 'k' });
  const j = r.json as { id: string; plaintextOnce: string };
  return { id: j.id, plaintext: j.plaintextOnce };
}

async function listKey(id: string): Promise<KeyInfo | undefined> {
  const r = await adminFetch('GET', '/admin/api/keys');
  return (r.json as { keys: KeyInfo[] }).keys.find((k) => k.id === id);
}

describe('POST /admin/api/keys/:id/max-concurrency', () => {
  it('sets a valid limit → 200 { ok, maxConcurrency } and persists it', async () => {
    await bootDaemon();
    const { id } = await createKey();

    const r = await adminFetch('POST', `/admin/api/keys/${id}/max-concurrency`, { maxConcurrency: 10 });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, maxConcurrency: 10 });
    expect((await listKey(id))?.maxConcurrency).toBe(10);
  });

  it('null clears the limit (unlimited)', async () => {
    await bootDaemon();
    const { id } = await createKey();
    await adminFetch('POST', `/admin/api/keys/${id}/max-concurrency`, { maxConcurrency: 7 });

    const r = await adminFetch('POST', `/admin/api/keys/${id}/max-concurrency`, { maxConcurrency: null });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, maxConcurrency: null });
    expect((await listKey(id))?.maxConcurrency).toBeUndefined();
  });

  it('rejects out-of-range / non-integer values with 400 and persists nothing', async () => {
    await bootDaemon();
    const { id } = await createKey();

    for (const bad of [0, -1, 1.5, 1001, 'x', true]) {
      const r = await adminFetch('POST', `/admin/api/keys/${id}/max-concurrency`, { maxConcurrency: bad });
      expect(r.status, `value ${JSON.stringify(bad)}`).toBe(400);
    }
    // A missing field is also invalid (undefined ≠ null).
    const missing = await adminFetch('POST', `/admin/api/keys/${id}/max-concurrency`, {});
    expect(missing.status).toBe(400);

    expect((await listKey(id))?.maxConcurrency).toBeUndefined();
  });

  it('unknown id → 404 with ok:false', async () => {
    await bootDaemon();
    const r = await adminFetch('POST', '/admin/api/keys/does-not-exist/max-concurrency', { maxConcurrency: 5 });
    expect(r.status).toBe(404);
    expect((r.json as { ok: boolean }).ok).toBe(false);
  });
});

// ── No-secret-leak scan (keys list) ─────────────────────────────────────────────

describe('keys list is secret-free', () => {
  it('carries maxConcurrency but never keyHash or the plaintext secret', async () => {
    await bootDaemon();
    const { id, plaintext } = await createKey();
    await adminFetch('POST', `/admin/api/keys/${id}/max-concurrency`, { maxConcurrency: 3 });

    const r = await adminFetch('GET', '/admin/api/keys');
    expect((await listKey(id))?.maxConcurrency).toBe(3);
    expect(r.text).not.toContain('keyHash');
    // The non-secret display `keyPrefix` is exposed, but the one-time full
    // plaintext (a longer `sk-omnicross-…` secret) must never reappear.
    expect(r.text).not.toContain(plaintext);
  });
});

// ── Route: POST /admin/api/keys/:id/policy + own-spend on the list ───────────────

interface KeyPolicyInfo {
  id: string;
  dailyCostLimitUsd?: number | null;
  activationMode?: string;
  activationDays?: number | null;
  spend?: { dailyUsd: number; weeklyUsd: number; totalUsd: number };
}

async function listPolicyKey(id: string): Promise<KeyPolicyInfo | undefined> {
  const r = await adminFetch('GET', '/admin/api/keys');
  return (r.json as { keys: KeyPolicyInfo[] }).keys.find((k) => k.id === id);
}

describe('POST /admin/api/keys/:id/policy', () => {
  it('sets policy fields → 200 { ok } and surfaces them on the list', async () => {
    await bootDaemon();
    const { id } = await createKey();

    const r = await adminFetch('POST', `/admin/api/keys/${id}/policy`, {
      activationMode: 'activation',
      activationDays: 14,
      dailyCostLimitUsd: 5,
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    const key = await listPolicyKey(id);
    expect(key?.activationMode).toBe('activation');
    expect(key?.activationDays).toBe(14);
    expect(key?.dailyCostLimitUsd).toBe(5);
  });

  it('rejects a malformed policy value with 400 and persists nothing', async () => {
    await bootDaemon();
    const { id } = await createKey();
    const bad = await adminFetch('POST', `/admin/api/keys/${id}/policy`, { dailyCostLimitUsd: -1 });
    expect(bad.status).toBe(400);
    expect((await listPolicyKey(id))?.dailyCostLimitUsd).toBeUndefined();
  });

  it('unknown id → 404 with ok:false', async () => {
    await bootDaemon();
    const r = await adminFetch('POST', '/admin/api/keys/nope/policy', { dailyCostLimitUsd: 1 });
    expect(r.status).toBe(404);
    expect((r.json as { ok: boolean }).ok).toBe(false);
  });
});

describe('keys list surfaces each key OWN spend (leak-safe)', () => {
  it('attributes spend to the earning key only, not to another key', async () => {
    await bootDaemon();
    const { id: k1 } = await createKey();
    const { id: k2 } = await createKey();

    // Seed a durable usage row attributed to k1 (the spend tracker lazily seeds
    // from this jsonl on the GET below).
    const eventsPath = join(tmpDir, 'usage-events.jsonl');
    writeFileSync(
      eventsPath,
      JSON.stringify({
        id: 'evt-1',
        ts: Date.now(),
        messageId: null,
        parentMessageId: null,
        sessionId: null,
        providerId: 'a',
        model: 'mock-model',
        apiKeyId: k1,
        engineOrigin: 'completion',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        costUsd: 5,
        costSavedByCacheUsd: 0,
      }) + '\n',
      'utf8',
    );

    const k1Info = await listPolicyKey(k1);
    const k2Info = await listPolicyKey(k2);
    // k1 sees its own $5 total; k2's spend is untouched (no cross-attribution).
    expect(k1Info?.spend?.totalUsd).toBe(5);
    expect(k2Info?.spend?.totalUsd).toBe(0);
  });
});
