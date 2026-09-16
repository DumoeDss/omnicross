/** Stored permission-list persistence (the db layer the integration keys still use). */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { OutboundPermission } from '@omnicross/core';

import { toKeyInfo } from '../admin/adminApi';
import { JsonOutboundKeyDb } from '../ports/JsonOutboundKeyDb';

describe('JsonOutboundKeyDb.outboundApiKeysSetPermissions', () => {
  it('projects a secret-free client DTO holding every permission', async () => {
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
      // Client keys hold every permission by kind — the endpoint URL decides.
      expect(projected).toMatchObject({
        allowedEndpoints: ['chat', 'responses', 'messages', 'gemini', 'images'],
      });
      expect(JSON.stringify(projected)).not.toContain('HASH_SECRET_SENTINEL');
      expect(JSON.stringify(projected)).not.toContain('legacyPermissions');
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
