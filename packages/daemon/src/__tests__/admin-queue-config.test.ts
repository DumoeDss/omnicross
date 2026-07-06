/**
 * admin-queue-config.test.ts — the server queue-config admin surface
 * (`omnicross-uqc-daemon`, capability `outbound-queue-config-admin`).
 *
 * Covers:
 *  - `PUT /admin/api/server` STRICT queue-segment validation (valid → merged +
 *    applied + GET returns normalized; illegal → 400, nothing persisted; a patch
 *    without queue segments preserves the existing ones), and that `applyConfig`
 *    receives the merged segments.
 *  - `GET /admin/api/status` `queueStatus` exposure (included when running via a
 *    faked `getQueueStatus()`; omitted when not running).
 *  - No-secret-leak scan over `/server` + `/status`.
 *
 * Boots the FULL daemon in process (mirrors admin-server-kind-config.test.ts);
 * `getStatus()`/`getQueueStatus()` are spied to fake the running snapshot.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

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
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-queuecfg-'));
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
  vi.restoreAllMocks();
  if (daemon) {
    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    daemon.apiKeyPool.dispose();
  }
  resetDaemonSingletonsForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

interface ServerBody {
  server: {
    userMessageQueue: { enabled: boolean; delayMs: number; waitTimeoutMs: number };
    concurrencyQueue: { maxQueueSizeFactor: number; minQueueSize: number; waitTimeoutMs: number };
  };
}

async function getServer(): Promise<ServerBody['server']> {
  const r = await adminFetch('GET', '/admin/api/server');
  return (r.json as ServerBody).server;
}

// ── PUT /server queue-segment validation ────────────────────────────────────────

describe('PUT /admin/api/server queue segments', () => {
  it('accepts valid segments → merged, applied, and GET returns the normalized segment', async () => {
    await bootDaemon();
    const applySpy = vi.spyOn(daemon.outboundApiServer, 'applyConfig');

    const r = await adminFetch('PUT', '/admin/api/server', {
      userMessageQueue: { enabled: true, delayMs: 300, waitTimeoutMs: 60000 },
    });
    expect(r.status).toBe(200);

    const server = await getServer();
    expect(server.userMessageQueue).toEqual({ enabled: true, delayMs: 300, waitTimeoutMs: 60000 });
    // Untouched segment stays at the frozen defaults.
    expect(server.concurrencyQueue).toEqual({ maxQueueSizeFactor: 2, minQueueSize: 4, waitTimeoutMs: 60000 });

    // applyConfig received the merged segments.
    expect(applySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessageQueue: { enabled: true, delayMs: 300, waitTimeoutMs: 60000 },
        concurrencyQueue: { maxQueueSizeFactor: 2, minQueueSize: 4, waitTimeoutMs: 60000 },
      }),
    );
  });

  it('rejects an illegal queue value with 400 and persists nothing', async () => {
    await bootDaemon();
    const before = await getServer();

    const r = await adminFetch('PUT', '/admin/api/server', {
      concurrencyQueue: { maxQueueSizeFactor: 99, minQueueSize: 4, waitTimeoutMs: 60000 },
    });
    expect(r.status).toBe(400);

    // Nothing persisted — the config is unchanged from the pre-PUT snapshot.
    expect(await getServer()).toEqual(before);
  });

  it('a non-boolean enabled is rejected 400', async () => {
    await bootDaemon();
    const r = await adminFetch('PUT', '/admin/api/server', {
      userMessageQueue: { enabled: 'yes', delayMs: 200, waitTimeoutMs: 60000 },
    });
    expect(r.status).toBe(400);
  });

  it('a present-but-non-object segment (null / string) is rejected 400, nothing persisted', async () => {
    await bootDaemon();
    const before = await getServer();

    // Explicit null must not deref → 500; a scalar/array segment likewise.
    for (const bad of [
      { userMessageQueue: null },
      { concurrencyQueue: null },
      { userMessageQueue: 'nope' },
      { concurrencyQueue: [1, 2] },
    ]) {
      const r = await adminFetch('PUT', '/admin/api/server', bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }

    expect(await getServer()).toEqual(before);
  });

  it('a patch WITHOUT queue segments preserves the existing segments', async () => {
    await bootDaemon();
    // Set a segment first.
    await adminFetch('PUT', '/admin/api/server', {
      userMessageQueue: { enabled: true, delayMs: 500, waitTimeoutMs: 120000 },
    });

    // An unrelated edit (no queue segments) must not disturb them.
    const r = await adminFetch('PUT', '/admin/api/server', { networkBinding: false });
    expect(r.status).toBe(200);

    const server = await getServer();
    expect(server.userMessageQueue).toEqual({ enabled: true, delayMs: 500, waitTimeoutMs: 120000 });
  });
});

// ── GET /status queueStatus exposure ─────────────────────────────────────────────

describe('GET /admin/api/status queueStatus', () => {
  it('includes queueStatus (from getQueueStatus) when the server is running', async () => {
    await bootDaemon();
    const queueStatus = {
      serial: [{ providerId: 'a', holding: true, waiting: 2 }],
      concurrency: [{ apiKeyId: 'k1', active: 1, waiting: 3 }],
    };
    vi.spyOn(daemon.outboundApiServer, 'getStatus').mockReturnValue({
      running: true,
      port: 12345,
      loopbackUrl: 'http://127.0.0.1:12345',
      lanUrl: null,
      formats: null,
      lanFormats: null,
    });
    vi.spyOn(daemon.outboundApiServer, 'getQueueStatus').mockReturnValue(queueStatus);

    const r = await adminFetch('GET', '/admin/api/status');
    expect(r.status).toBe(200);
    const body = r.json as { running: boolean; endpoints: unknown; queueStatus?: unknown };
    expect(body.running).toBe(true);
    expect(body.queueStatus).toEqual(queueStatus);
    // Existing fields unchanged.
    expect(Array.isArray(body.endpoints)).toBe(true);
  });

  it('omits queueStatus when the server is not running', async () => {
    await bootDaemon();
    // Boots with enabled:false → not running; getQueueStatus must not appear.
    const r = await adminFetch('GET', '/admin/api/status');
    expect(r.status).toBe(200);
    const body = r.json as { running: boolean; queueStatus?: unknown };
    expect(body.running).toBe(false);
    expect('queueStatus' in body).toBe(false);
  });
});

// ── No-secret-leak scan (/server + /status) ──────────────────────────────────────

describe('/server and /status are secret-free', () => {
  it('never serialize keyHash or an sk-omnicross- plaintext', async () => {
    await bootDaemon();
    // Mint a key so keys.json holds a real keyHash + prefix (nothing that /server
    // or /status should ever echo).
    await adminFetch('POST', '/admin/api/keys', { name: 'scan' });

    const server = await adminFetch('GET', '/admin/api/server');
    const status = await adminFetch('GET', '/admin/api/status');
    for (const text of [server.text, status.text]) {
      expect(text).not.toContain('keyHash');
      expect(text).not.toContain('sk-omnicross-');
    }
  });
});
