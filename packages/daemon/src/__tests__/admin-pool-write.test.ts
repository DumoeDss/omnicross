/**
 * admin-pool-write.test.ts — the pool-key WRITE surface (app-parity child 3):
 * `POST /providers/:id/keys` (add), `PUT /providers/:id/keys/:keyId` (update),
 * `DELETE /providers/:id/keys/:keyId` (remove), and
 * `POST /providers/:id/keys/:keyId/enabled` (toggle).
 *
 * Boots the full daemon in process (same pattern as `admin-pool-health.test.ts`)
 * with a master-key file → `buildDaemon` always installs a `SecretBox`, so the
 * encrypted-at-rest assertion reads the real on-disk envelope. Each write submits
 * a SENTINEL plaintext key on the request IN and asserts the response is ONLY the
 * masked health view (secret-IN-never-OUT). Two providers (A + B) prove
 * cross-provider isolation. Disk round-trips via re-`loadConfig`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadServerConfig } from '@omnicross/core/outbound-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { type DaemonProviderConfig, loadConfig } from '../config';
import { isEnvelope } from '../secrets';

// The plaintext key submitted on add/update — the no-leak net asserts it never
// appears in ANY response body. A $ENV var name we also assert never leaks.
const SENTINEL_KEY = 'sk-poolwrite-SENTINEL-zzzz9999';
const SENTINEL_KEY_2 = 'sk-poolwrite-SENTINEL-yyyy8888';
const SENTINEL_ENV_VAR = 'OMNI_POOLWRITE_SENTINEL_VAR';

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

let tmpDir: string;
let daemon: Daemon;
let configPath: string;

type PoolKeyView = { id: string; label: string; enabled: boolean; weight: number; apiKeyMasked: string };

function keysOf(r: { json: unknown }): PoolKeyView[] {
  return (r.json as { keys: PoolKeyView[] }).keys;
}

/** Read the RAW (still-encrypted) provider row straight off disk (no decrypt). */
function rawProviderOnDisk(id: string): Record<string, unknown> {
  const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as {
    providers: Array<Record<string, unknown>>;
  };
  return onDisk.providers.find((p) => p['id'] === id)!;
}

/** Read the DECRYPTED provider row via `loadConfig` (the SecretBox is installed). */
function loadedProvider(id: string): DaemonProviderConfig {
  return loadConfig(configPath).providers.find((p) => p.id === id)!;
}

function writeConfig(path: string): void {
  const cfg = {
    providers: [
      {
        id: 'pa',
        apiFormat: 'openai',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: '',
        apiKeys: [{ id: 'pa-k1', apiKey: 'sk-existing-pa-1111', label: 'pa-primary', weight: 2 }],
        models: ['mock-model'],
      },
      {
        id: 'pb',
        apiFormat: 'openai',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: '',
        apiKeys: [{ id: 'pb-k1', apiKey: 'sk-existing-pb-2222', label: 'pb-primary', weight: 1 }],
        models: ['mock-model'],
      },
    ],
    server: { enabled: false, networkBinding: false, port: 0, endpoints: [] },
    admin: { port: 0 },
  };
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
}

beforeEach(async () => {
  resetDaemonSingletonsForTests();
  process.env[SENTINEL_ENV_VAR] = 'sk-poolwrite-env-resolved-7777';
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-pool-write-'));
  configPath = join(tmpDir, 'config.json');
  const keysPath = join(tmpDir, 'keys.json');
  const tokensPath = join(tmpDir, 'tokens.json');
  writeConfig(configPath);

  const config = loadConfig(configPath);
  daemon = buildDaemon(config, {
    configPath,
    keysPath,
    tokensPath,
    masterKeyFilePath: join(tmpDir, 'master.key'),
  });
  await daemon.llmConfig.ready();
  // Materialize the server config store (the admin server reads it on start).
  await loadServerConfig(daemon.settingsStore);
  await daemon.adminServer.start();
  adminBase = daemon.adminServer.getStatus().url as string;
});

afterEach(async () => {
  if (daemon) {
    await daemon.adminServer.stop();
    daemon.apiKeyPool.dispose();
  }
  resetDaemonSingletonsForTests();
  Reflect.deleteProperty(process.env, SENTINEL_ENV_VAR);
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('pool-key write surface — add', () => {
  it('POST add → masked entry in response, GET shows it, disk has it (3.2)', async () => {
    const r = await adminFetch('POST', '/admin/api/providers/pa/keys', {
      label: 'k-new',
      weight: 3,
      apiKey: SENTINEL_KEY,
    });
    expect(r.status).toBe(201);
    const keys = keysOf(r);
    // The new entry is present + masked (no literal key in the body).
    const added = keys.find((k) => k.label === 'k-new')!;
    expect(added).toBeTruthy();
    expect(added.weight).toBe(3);
    expect(added.enabled).toBe(true);
    expect(added.apiKeyMasked).toBe('sk-…9999');
    expect(r.text).not.toContain(SENTINEL_KEY);

    // GET reflects it.
    const get = await adminFetch('GET', '/admin/api/providers/pa/keys');
    expect(keysOf(get).some((k) => k.id === added.id)).toBe(true);

    // Disk (decrypted via loadConfig) has the new entry in apiKeys[].
    const onDisk = loadedProvider('pa');
    const diskEntry = onDisk.apiKeys!.find((k) => k.id === added.id)!;
    expect(diskEntry.apiKey).toBe(SENTINEL_KEY);
    expect(diskEntry.label).toBe('k-new');
    expect(diskEntry.weight).toBe(3);
  });

  it('POST add with a blank apiKey → 400, no entry added (3.3)', async () => {
    const before = loadedProvider('pa').apiKeys!.length;
    const blank = await adminFetch('POST', '/admin/api/providers/pa/keys', { label: 'no-key', apiKey: '' });
    expect(blank.status).toBe(400);
    const omitted = await adminFetch('POST', '/admin/api/providers/pa/keys', { label: 'no-key' });
    expect(omitted.status).toBe(400);
    expect(loadedProvider('pa').apiKeys!.length).toBe(before);
  });
});

describe('pool-key write surface — update', () => {
  it('PUT weight/label/enabled with no apiKey keeps the stored key; a new apiKey replaces it (3.4)', async () => {
    // Update metadata only (no apiKey) → the stored key is kept.
    const upd = await adminFetch('PUT', '/admin/api/providers/pa/keys/pa-k1', {
      weight: 9,
      label: 'renamed',
      enabled: false,
    });
    expect(upd.status).toBe(200);
    const k1 = keysOf(upd).find((k) => k.id === 'pa-k1')!;
    expect(k1.weight).toBe(9);
    expect(k1.label).toBe('renamed');
    expect(k1.enabled).toBe(false);
    expect(k1.apiKeyMasked).toBe('sk-…1111'); // stored key kept (masked unchanged)
    expect(loadedProvider('pa').apiKeys!.find((k) => k.id === 'pa-k1')!.apiKey).toBe('sk-existing-pa-1111');

    // Update WITH a new apiKey → replaces it (re-encrypted at rest).
    const rot = await adminFetch('PUT', '/admin/api/providers/pa/keys/pa-k1', { apiKey: SENTINEL_KEY });
    expect(rot.status).toBe(200);
    const k1b = keysOf(rot).find((k) => k.id === 'pa-k1')!;
    expect(k1b.apiKeyMasked).toBe('sk-…9999');
    // The prior metadata edits persisted across the key-only update.
    expect(k1b.weight).toBe(9);
    expect(k1b.label).toBe('renamed');
    expect(loadedProvider('pa').apiKeys!.find((k) => k.id === 'pa-k1')!.apiKey).toBe(SENTINEL_KEY);
    expect(rot.text).not.toContain(SENTINEL_KEY);
  });
});

describe('pool-key write surface — delete + toggle', () => {
  it('DELETE removes the entry; POST :keyId/enabled flips it (3.5)', async () => {
    // Add a second key so the delete does not empty the pool.
    const add = await adminFetch('POST', '/admin/api/providers/pa/keys', { apiKey: SENTINEL_KEY_2, label: 'k2' });
    const addedId = keysOf(add).find((k) => k.label === 'k2')!.id;

    const del = await adminFetch('DELETE', `/admin/api/providers/pa/keys/${addedId}`);
    expect(del.status).toBe(200);
    expect(keysOf(del).some((k) => k.id === addedId)).toBe(false);
    const get1 = await adminFetch('GET', '/admin/api/providers/pa/keys');
    expect(keysOf(get1).some((k) => k.id === addedId)).toBe(false);

    // Toggle pa-k1 off.
    const tog = await adminFetch('POST', '/admin/api/providers/pa/keys/pa-k1/enabled', { enabled: false });
    expect(tog.status).toBe(200);
    expect(keysOf(tog).find((k) => k.id === 'pa-k1')!.enabled).toBe(false);
    const get2 = await adminFetch('GET', '/admin/api/providers/pa/keys');
    expect(keysOf(get2).find((k) => k.id === 'pa-k1')!.enabled).toBe(false);
    expect(loadedProvider('pa').apiKeys!.find((k) => k.id === 'pa-k1')!.enabled).toBe(false);
  });

  it('DELETE the last pool key collapses apiKeys to undefined (single-key fallback)', async () => {
    const del = await adminFetch('DELETE', '/admin/api/providers/pb/keys/pb-k1');
    expect(del.status).toBe(200);
    expect(keysOf(del)).toHaveLength(0);
    // Disk: empty pool collapses to undefined (validateApiKeys contract).
    expect(rawProviderOnDisk('pb')['apiKeys']).toBeUndefined();
    expect(loadedProvider('pb').apiKeys).toBeUndefined();
  });
});

describe('pool-key write surface — deny-by-default', () => {
  it('add/update drop a non-allowlisted field; only {id,apiKey,label?,enabled?,weight?} persist (3.6)', async () => {
    const add = await adminFetch('POST', '/admin/api/providers/pa/keys', {
      apiKey: SENTINEL_KEY,
      label: 'k-deny',
      weight: 4,
      bogusField: 'EVIL',
      providerId: 'pb', // even a smuggled providerId must be ignored (path wins)
      id: 'client-suggested-id', // OQ2: a client-suggested id is NOT accepted
    });
    expect(add.status).toBe(201);
    const added = keysOf(add).find((k) => k.label === 'k-deny')!;
    expect(added.id).not.toBe('client-suggested-id');

    // On disk (decrypted), the entry carries ONLY the allowlisted keys.
    const diskEntry = loadedProvider('pa').apiKeys!.find((k) => k.id === added.id)!;
    expect(Object.keys(diskEntry).sort()).toEqual(['apiKey', 'id', 'label', 'weight']);
    // Raw on-disk JSON never contains the bogus field anywhere on the provider.
    expect(JSON.stringify(rawProviderOnDisk('pa'))).not.toContain('bogusField');
    expect(JSON.stringify(rawProviderOnDisk('pa'))).not.toContain('EVIL');

    // Same for update.
    const upd = await adminFetch('PUT', `/admin/api/providers/pa/keys/${added.id}`, {
      weight: 7,
      anotherBogus: 'NOPE',
    });
    expect(upd.status).toBe(200);
    expect(JSON.stringify(rawProviderOnDisk('pa'))).not.toContain('anotherBogus');
    expect(JSON.stringify(rawProviderOnDisk('pa'))).not.toContain('NOPE');
    const diskEntry2 = loadedProvider('pa').apiKeys!.find((k) => k.id === added.id)!;
    expect(Object.keys(diskEntry2).sort()).toEqual(['apiKey', 'id', 'label', 'weight']);
  });
});

describe('pool-key write surface — encrypted at rest', () => {
  it('a key added through the write surface is an enc: envelope on disk (3.7)', async () => {
    const add = await adminFetch('POST', '/admin/api/providers/pa/keys', { apiKey: SENTINEL_KEY, label: 'enc' });
    const addedId = keysOf(add).find((k) => k.label === 'enc')!.id;

    const raw = rawProviderOnDisk('pa');
    const rawEntries = raw['apiKeys'] as Array<Record<string, unknown>>;
    const rawAdded = rawEntries.find((k) => k['id'] === addedId)!;
    // On disk the apiKey is an envelope, NOT the plaintext sentinel.
    expect(isEnvelope(String(rawAdded['apiKey']))).toBe(true);
    expect(readFileSync(configPath, 'utf8')).not.toContain(SENTINEL_KEY);
    // loadConfig (with the box) decrypts it back to the sentinel.
    expect(loadedProvider('pa').apiKeys!.find((k) => k.id === addedId)!.apiKey).toBe(SENTINEL_KEY);
  });

  it('a $ENV reference written through add is stored verbatim (never encrypted)', async () => {
    const add = await adminFetch('POST', '/admin/api/providers/pa/keys', {
      apiKey: `$${SENTINEL_ENV_VAR}`,
      label: 'env',
    });
    expect(add.status).toBe(201);
    const added = keysOf(add).find((k) => k.label === 'env')!;
    // The masked view never echoes the var name.
    expect(added.apiKeyMasked).toBe('$ENV(•••)');
    const raw = rawProviderOnDisk('pa');
    const rawEntries = raw['apiKeys'] as Array<Record<string, unknown>>;
    const rawAdded = rawEntries.find((k) => k['id'] === added.id)!;
    // A $ENV ref is left untouched (tri-state idempotent), NOT an envelope.
    expect(rawAdded['apiKey']).toBe(`$${SENTINEL_ENV_VAR}`);
    expect(isEnvelope(String(rawAdded['apiKey']))).toBe(false);
  });
});

describe('pool-key write surface — no secret leak', () => {
  it('the submitted sentinel never appears in any write/read response (3.8)', async () => {
    const add = await adminFetch('POST', '/admin/api/providers/pa/keys', {
      apiKey: SENTINEL_KEY,
      label: 'leak-add',
    });
    const addedId = keysOf(add).find((k) => k.label === 'leak-add')!.id;
    const upd = await adminFetch('PUT', `/admin/api/providers/pa/keys/${addedId}`, { apiKey: SENTINEL_KEY_2 });
    const tog = await adminFetch('POST', `/admin/api/providers/pa/keys/${addedId}/enabled`, { enabled: false });
    const get = await adminFetch('GET', '/admin/api/providers/pa/keys');

    for (const r of [add, upd, tog, get]) {
      expect(r.text).not.toContain(SENTINEL_KEY);
      expect(r.text).not.toContain(SENTINEL_KEY_2);
      expect(r.text).not.toContain(SENTINEL_ENV_VAR);
      expect(r.text).not.toContain(process.env[SENTINEL_ENV_VAR]!);
    }
  });
});

describe('pool-key write surface — 404 + cross-provider isolation', () => {
  it('404s an unknown provider / key id on every write; provider B is untouched by a write to A (3.9)', async () => {
    // Unknown provider on each verb.
    expect((await adminFetch('POST', '/admin/api/providers/nope/keys', { apiKey: SENTINEL_KEY })).status).toBe(404);
    expect((await adminFetch('PUT', '/admin/api/providers/nope/keys/x', { weight: 1 })).status).toBe(404);
    expect((await adminFetch('DELETE', '/admin/api/providers/nope/keys/x')).status).toBe(404);
    expect((await adminFetch('POST', '/admin/api/providers/nope/keys/x/enabled', { enabled: true })).status).toBe(404);

    // Unknown key id on a real provider.
    expect((await adminFetch('PUT', '/admin/api/providers/pa/keys/ghost', { weight: 1 })).status).toBe(404);
    expect((await adminFetch('DELETE', '/admin/api/providers/pa/keys/ghost')).status).toBe(404);
    expect((await adminFetch('POST', '/admin/api/providers/pa/keys/ghost/enabled', { enabled: true })).status).toBe(404);

    // Snapshot provider B's pool, then mutate provider A heavily.
    const bBefore = JSON.stringify(loadedProvider('pb').apiKeys);
    await adminFetch('POST', '/admin/api/providers/pa/keys', { apiKey: SENTINEL_KEY, label: 'iso-add' });
    await adminFetch('PUT', '/admin/api/providers/pa/keys/pa-k1', { weight: 42, apiKey: SENTINEL_KEY_2 });
    await adminFetch('POST', '/admin/api/providers/pa/keys/pa-k1/enabled', { enabled: false });
    // Provider B's pool is byte-identical (decrypted) after all of A's writes.
    expect(JSON.stringify(loadedProvider('pb').apiKeys)).toBe(bBefore);
  });
});
