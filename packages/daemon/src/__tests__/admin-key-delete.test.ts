/**
 * admin-key-delete.test.ts — permanent key removal (hard delete) + the
 * `DELETE /admin/api/keys/:id` admin route (outbound-key-delete).
 *
 * Revoke (soft) keeps a key's row for history; delete (hard) purges it so the
 * operator can clean up the revoked keys that otherwise pile up in the list.
 *
 * Covers:
 *  - `JsonOutboundKeyDb.outboundApiKeysDelete` removes the row (round-trips
 *    through the file) and returns false for an unknown id.
 *  - The delete route: 200 { ok: true } for a known id (and the key leaves the
 *    list), 404 for an unknown id.
 *
 * The route tests boot the FULL daemon in process; the port test drives
 * `JsonOutboundKeyDb` directly.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-keydel-'));
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

async function createKey(name = 'k'): Promise<{ id: string }> {
  const r = await adminFetch('POST', '/admin/api/keys', { name });
  return { id: (r.json as { id: string }).id };
}

async function keyIds(): Promise<string[]> {
  const r = await adminFetch('GET', '/admin/api/keys');
  return (r.json as { keys: { id: string }[] }).keys.map((k) => k.id);
}

// ── Port: JsonOutboundKeyDb.outboundApiKeysDelete ──────────────────────────────

describe('JsonOutboundKeyDb.outboundApiKeysDelete', () => {
  it('removes the row and round-trips through the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-keydb-'));
    try {
      const keysPath = join(dir, 'keys.json');
      const db = new JsonOutboundKeyDb(keysPath);
      await db.outboundApiKeysCreate({ id: 'k1', name: 'k1', keyHash: 'h1', keyPrefix: 'sk-omnicross-a' });
      await db.outboundApiKeysCreate({ id: 'k2', name: 'k2', keyHash: 'h2', keyPrefix: 'sk-omnicross-b' });

      expect(await db.outboundApiKeysDelete('k1')).toBe(true);
      const after = await new JsonOutboundKeyDb(keysPath).outboundApiKeysList();
      expect(after.map((r) => r.id)).toEqual(['k2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false for an unknown id and changes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-keydb-'));
    try {
      const db = new JsonOutboundKeyDb(join(dir, 'keys.json'));
      expect(await db.outboundApiKeysDelete('nope')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Route: DELETE /admin/api/keys/:id ─────────────────────────────────────────

describe('DELETE /admin/api/keys/:id', () => {
  it('permanently removes the key → 200 { ok: true } and it leaves the list', async () => {
    await bootDaemon();
    const { id } = await createKey();
    expect(await keyIds()).toContain(id);

    const r = await adminFetch('DELETE', `/admin/api/keys/${id}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(await keyIds()).not.toContain(id);
  });

  it('also removes an already-revoked key (the cleanup use case)', async () => {
    await bootDaemon();
    const { id } = await createKey();
    await adminFetch('POST', `/admin/api/keys/${id}/revoke`);

    const r = await adminFetch('DELETE', `/admin/api/keys/${id}`);
    expect(r.status).toBe(200);
    expect(await keyIds()).not.toContain(id);
  });

  it('unknown id → 404', async () => {
    await bootDaemon();
    const r = await adminFetch('DELETE', '/admin/api/keys/does-not-exist');
    expect(r.status).toBe(404);
  });
});
