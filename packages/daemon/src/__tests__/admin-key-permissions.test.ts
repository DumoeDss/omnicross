/** Exact Images permission persistence and authenticated admin mutation coverage. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { OutboundPermission } from '@omnicross/core';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { toKeyInfo } from '../admin/adminApi';
import { loadConfig } from '../config';
import { JsonOutboundKeyDb } from '../ports/JsonOutboundKeyDb';

describe('JsonOutboundKeyDb.outboundApiKeysSetPermissions', () => {
  it('projects an explicit secret-free legacy marker beside effective text permissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-key-permissions-'));
    try {
      const db = new JsonOutboundKeyDb(join(dir, 'keys.json'));
      await db.outboundApiKeysCreate({
        id: 'legacy-key',
        name: 'legacy',
        keyHash: 'HASH_SECRET_SENTINEL',
        keyPrefix: 'oc_legacy',
      });
      const stored = (await db.outboundApiKeysList())[0]!;
      const projected = toKeyInfo(stored);
      expect(projected).toMatchObject({
        legacyPermissions: true,
        allowedEndpoints: ['chat', 'responses', 'messages', 'gemini'],
      });
      expect(JSON.stringify(projected)).not.toContain('HASH_SECRET_SENTINEL');
      expect(JSON.stringify(projected)).not.toContain('images');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips exact and empty lists while rejecting invalid, missing, and revoked writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-key-permissions-'));
    try {
      const keysPath = join(dir, 'keys.json');
      const db = new JsonOutboundKeyDb(keysPath);
      await db.outboundApiKeysCreate({
        id: 'k1',
        name: 'key',
        keyHash: 'hash',
        keyPrefix: 'prefix',
      });

      expect(await db.outboundApiKeysSetPermissions('k1', ['responses', 'images'])).toBe(true);
      expect((await new JsonOutboundKeyDb(keysPath).outboundApiKeysList())[0].allowedEndpoints)
        .toEqual(['responses', 'images']);

      expect(await db.outboundApiKeysSetPermissions('k1', [])).toBe(true);
      expect((await new JsonOutboundKeyDb(keysPath).outboundApiKeysList())[0].allowedEndpoints)
        .toEqual([]);

      const beforeInvalid = readFileSync(keysPath, 'utf8');
      await expect(
        db.outboundApiKeysSetPermissions('k1', ['images', 'images']),
      ).rejects.toThrow(/duplicates/);
      await expect(
        db.outboundApiKeysSetPermissions('k1', ['unknown'] as unknown as OutboundPermission[]),
      ).rejects.toThrow(/unknown/);
      expect(readFileSync(keysPath, 'utf8')).toBe(beforeInvalid);

      expect(await db.outboundApiKeysSetPermissions('missing', ['images'])).toBe(false);
      await db.outboundApiKeysRevoke('k1');
      expect(await db.outboundApiKeysSetPermissions('k1', ['images'])).toBe(false);
      expect((await db.outboundApiKeysList())[0].allowedEndpoints).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the previous effective policy when the atomic replacement fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-key-permissions-'));
    try {
      const keysPath = join(dir, 'keys.json');
      const seed = new JsonOutboundKeyDb(keysPath);
      await seed.outboundApiKeysCreate({
        id: 'k1',
        name: 'key',
        keyHash: 'hash',
        keyPrefix: 'prefix',
        allowedEndpoints: ['responses'],
      });
      const before = readFileSync(keysPath, 'utf8');
      const failing = new JsonOutboundKeyDb(keysPath, undefined, () => {
        throw new Error('injected atomic replace failure');
      });

      await expect(failing.outboundApiKeysSetPermissions('k1', ['images']))
        .rejects.toThrow('injected atomic replace failure');
      expect(readFileSync(keysPath, 'utf8')).toBe(before);
      expect((await new JsonOutboundKeyDb(keysPath).outboundApiKeysList())[0].allowedEndpoints)
        .toEqual(['responses']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

let daemon: Daemon | undefined;
let tempHome: string | undefined;
let adminBase = '';

async function bootDaemon(): Promise<void> {
  resetDaemonSingletonsForTests();
  tempHome = mkdtempSync(join(tmpdir(), 'omnicross-admin-permissions-'));
  const configPath = join(tempHome, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      providers: [
        {
          id: 'a',
          apiFormat: 'openai',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: 'test-only-provider-key',
          models: ['mock-model'],
        },
      ],
      server: { enabled: false, networkBinding: false, port: 0, endpoints: [] },
      admin: { port: 0 },
    }, null, 2),
    'utf8',
  );
  const config = loadConfig(configPath);
  daemon = buildDaemon(config, {
    configPath,
    keysPath: join(tempHome, 'keys.json'),
    tokensPath: join(tempHome, 'tokens.json'),
    masterKeyFilePath: join(tempHome, 'master.key'),
  });
  await daemon.llmConfig.ready();
  await daemon.adminServer.start();
  adminBase = daemon.adminServer.getStatus().url as string;
}

async function adminFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; json: unknown }> {
  const response = await fetch(`${adminBase}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

afterEach(async () => {
  if (daemon) {
    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    daemon.apiKeyPool.dispose();
  }
  daemon = undefined;
  resetDaemonSingletonsForTests();
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = undefined;
});

describe('POST /admin/api/keys/:id/permissions', () => {
  it('returns exact safe DTOs and atomically replaces the live key permission list', async () => {
    await bootDaemon();
    const created = await adminFetch('POST', '/admin/api/keys', { name: 'images-client' });
    const createdBody = created.json as {
      id: string;
      plaintextOnce: string;
      allowedEndpoints: OutboundPermission[];
    };
    expect(createdBody.allowedEndpoints).toEqual(['chat', 'responses', 'messages', 'gemini']);

    const updated = await adminFetch(
      'POST',
      `/admin/api/keys/${encodeURIComponent(createdBody.id)}/permissions`,
      { permissions: ['responses', 'images'] },
    );
    expect(updated.status).toBe(200);
    expect(updated.json).toEqual({ ok: true, allowedEndpoints: ['responses', 'images'] });

    const listed = await adminFetch('GET', '/admin/api/keys');
    const row = (listed.json as { keys: Array<{ id: string; allowedEndpoints: OutboundPermission[] }> })
      .keys.find((entry) => entry.id === createdBody.id);
    expect(row?.allowedEndpoints).toEqual(['responses', 'images']);
    expect(listed.text).not.toContain(createdBody.plaintextOnce);
    expect(listed.text).not.toContain('keyHash');
  });

  it('rejects malformed writes without changing policy and distinguishes missing from revoked', async () => {
    await bootDaemon();
    const created = await adminFetch('POST', '/admin/api/keys', { name: 'images-client' });
    const id = (created.json as { id: string }).id;

    for (const permissions of [['images', 'images'], ['files'], 'images', null]) {
      const rejected = await adminFetch(
        'POST',
        `/admin/api/keys/${encodeURIComponent(id)}/permissions`,
        { permissions },
      );
      expect(rejected.status).toBe(400);
    }
    const after = await adminFetch('GET', '/admin/api/keys');
    const row = (after.json as { keys: Array<{ id: string; allowedEndpoints: OutboundPermission[] }> })
      .keys.find((entry) => entry.id === id);
    expect(row?.allowedEndpoints).toEqual(['chat', 'responses', 'messages', 'gemini']);

    const missing = await adminFetch('POST', '/admin/api/keys/missing/permissions', {
      permissions: ['images'],
    });
    expect(missing.status).toBe(404);

    expect((await adminFetch('POST', `/admin/api/keys/${id}/revoke`)).status).toBe(200);
    const revoked = await adminFetch('POST', `/admin/api/keys/${id}/permissions`, {
      permissions: ['images'],
    });
    expect(revoked.status).toBe(409);
  });
});
