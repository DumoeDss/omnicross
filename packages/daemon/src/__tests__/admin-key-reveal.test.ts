/**
 * admin-key-reveal.test.ts — reversible "view key" storage + the
 * `GET /admin/api/keys/:id/reveal` admin route (outbound-key-reveal).
 *
 * Covers:
 *  - `JsonOutboundKeyDb` persists a `keySecret` envelope on create ONLY when a
 *    `SecretBox` is wired, and `outboundApiKeysReveal` decrypts it back (round-
 *    trips through the file). Without a box the store stays hash-only (legacy).
 *  - The reveal route: 200 with the decrypted plaintext (matching the one-time
 *    `plaintextOnce`), 404 for an unknown id, 409 for a legacy hash-only row.
 *  - The keys-list DTO carries `revealable` (true for new keys, false for
 *    legacy) and still never leaks `keyHash` or the stored envelope.
 *
 * The route tests boot the FULL daemon in process (the bootstrap wires the
 * `SecretBox` into the key DB); the port tests drive `JsonOutboundKeyDb`
 * directly with + without a `SecretBox`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';
import { JsonOutboundKeyDb } from '../ports/JsonOutboundKeyDb';
import { SecretBox } from '../secrets/SecretBox';

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
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-keyreveal-'));
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
    // A real (auto-generated) master key → the bootstrap wires a SecretBox into
    // the key DB, so newly created keys are revealable.
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

async function createKey(): Promise<{ id: string; plaintext: string }> {
  const r = await adminFetch('POST', '/admin/api/keys', { name: 'k' });
  const j = r.json as { id: string; plaintextOnce: string };
  return { id: j.id, plaintext: j.plaintextOnce };
}

// ── Port: JsonOutboundKeyDb revealable storage ─────────────────────────────────

describe('JsonOutboundKeyDb revealable storage', () => {
  it('persists a keySecret envelope when a SecretBox is wired and reveals it back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-keydb-'));
    try {
      const keysPath = join(dir, 'keys.json');
      const box = new SecretBox(Buffer.alloc(32, 7));
      const db = new JsonOutboundKeyDb(keysPath, box);
      const row = await db.outboundApiKeysCreate({
        id: 'k1',
        name: 'k1',
        keyHash: 'hash-1',
        keyPrefix: 'sk-omnicross-abcd',
        plaintext: 'sk-omnicross-secretvalue',
      });
      expect(row.keySecret).toBeTruthy();
      expect(row.keySecret).not.toBe('sk-omnicross-secretvalue'); // encrypted, not plaintext

      expect(await db.outboundApiKeysReveal('k1')).toBe('sk-omnicross-secretvalue');

      // Round-trips through the file: a FRESH instance with the same key reveals
      // the same plaintext (proves the envelope was persisted, not in-memory).
      const reloaded = new JsonOutboundKeyDb(keysPath, box);
      expect(await reloaded.outboundApiKeysReveal('k1')).toBe('sk-omnicross-secretvalue');
      // And the on-disk row never stores bare plaintext.
      const onDisk = JSON.parse(readFileSync(keysPath, 'utf8')) as Array<{ keySecret?: string }>;
      expect(onDisk[0].keySecret).not.toContain('secretvalue');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays hash-only without a SecretBox (byte-identical to legacy)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-keydb-'));
    try {
      const keysPath = join(dir, 'keys.json');
      const db = new JsonOutboundKeyDb(keysPath); // no box
      const row = await db.outboundApiKeysCreate({
        id: 'k1',
        name: 'k1',
        keyHash: 'hash-1',
        keyPrefix: 'sk-omnicross-abcd',
        plaintext: 'sk-omnicross-secretvalue',
      });
      expect(row.keySecret).toBeUndefined();
      expect(await db.outboundApiKeysReveal('k1')).toBeNull();

      // A legacy row (no keySecret) is not revealable even under a box.
      const boxed = new JsonOutboundKeyDb(keysPath, new SecretBox(Buffer.alloc(32, 9)));
      expect(await boxed.outboundApiKeysReveal('k1')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reveal returns null for an unknown id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-keydb-'));
    try {
      const db = new JsonOutboundKeyDb(join(dir, 'keys.json'), new SecretBox(Buffer.alloc(32, 1)));
      expect(await db.outboundApiKeysReveal('nope')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Route: GET /admin/api/keys/:id/reveal ─────────────────────────────────────

describe('GET /admin/api/keys/:id/reveal', () => {
  it('returns the decrypted plaintext matching plaintextOnce → 200', async () => {
    await bootDaemon();
    const { id, plaintext } = await createKey();

    const r = await adminFetch('GET', `/admin/api/keys/${id}/reveal`);
    expect(r.status).toBe(200);
    expect((r.json as { key: string }).key).toBe(plaintext);
  });

  it('surfaces revealable on the list (true for new keys) without leaking the envelope', async () => {
    await bootDaemon();
    const { id, plaintext } = await createKey();

    const list = await adminFetch('GET', '/admin/api/keys');
    const key = (list.json as { keys: Array<{ id: string; revealable?: boolean }> }).keys.find((k) => k.id === id);
    expect(key?.revealable).toBe(true);
    // The list is still secret-free: no keyHash, no `enc:` envelope, no plaintext.
    expect(list.text).not.toContain('keyHash');
    expect(list.text).not.toContain('enc:v1');
    expect(list.text).not.toContain(plaintext);
  });

  it('unknown id → 404', async () => {
    await bootDaemon();
    const r = await adminFetch('GET', '/admin/api/keys/does-not-exist/reveal');
    expect(r.status).toBe(404);
  });

  it('legacy hash-only row → 409 (exists but not revealable) and lists revealable:false', async () => {
    await bootDaemon();
    // Seed a pre-upgrade row directly into keys.json — hash-only, no keySecret.
    await adminFetch('POST', '/admin/api/keys', { name: 'modern' }); // ensure file exists
    const keysPath = join(tmpDir, 'keys.json');
    const rows = JSON.parse(readFileSync(keysPath, 'utf8')) as Array<Record<string, unknown>>;
    rows.push({
      id: 'legacy',
      name: 'legacy',
      keyHash: 'hash-legacy',
      keyPrefix: 'sk-omnicross-l',
      enabled: true,
      createdAt: 1,
      lastUsedAt: null,
      revokedAt: null,
    });
    writeFileSync(keysPath, JSON.stringify(rows, null, 2), 'utf8');

    const r = await adminFetch('GET', '/admin/api/keys/legacy/reveal');
    expect(r.status).toBe(409);

    const list = await adminFetch('GET', '/admin/api/keys');
    const key = (list.json as { keys: Array<{ id: string; revealable?: boolean }> }).keys.find((k) => k.id === 'legacy');
    expect(key?.revealable).toBe(false);
  });
});
