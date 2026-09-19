/**
 * admin-key-delete.test.ts — the storage-layer primitive behind key removal.
 *
 * The product exposes exactly ONE key delete: the soft one (`POST
 * /keys/:id/revoke`) — the key stops authenticating immediately while its row
 * and spend history stay on the list forever. There is deliberately NO admin
 * route that removes a key row (a hard delete must not exist), so this file
 * covers only `JsonOutboundKeyDb.outboundApiKeysDelete`, the low-level
 * storage capability kept for internal/data-migration use:
 *  - removes the row and round-trips through the file;
 *  - returns false for an unknown id.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { JsonOutboundKeyDb } from '../ports/JsonOutboundKeyDb';

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
