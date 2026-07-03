/**
 * admin-usage-dashboard.test.ts — the two udash-api routes:
 *   - `GET /admin/api/usage/timeseries?startTs&endTs&bucket=` (zero-filled
 *     buckets; bad-bucket / bad-range / pathological-range 400s);
 *   - `GET /admin/api/dashboard` (counts-only summary; secret-free; running flag;
 *     405 on POST).
 *
 * Boots the full daemon in process (mirrors `admin-usage-pricing.test.ts`) with
 * an admin token so the auth gate is exercised.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UsageTimeSeriesBucket } from '@omnicross/contracts/usage-stats-types';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

const ADMIN_TOKEN = 'admin-token-SENTINEL';
const POOL_KEY_SECRET = 'sk-poolkey-SENTINEL-zzzz9999';

let tmpDir: string;
let daemon: Daemon;
let adminBase: string;

async function adminFetch(
  method: string,
  path: string,
  body?: unknown,
  opts: { auth?: boolean } = {},
): Promise<{ status: number; text: string; json: unknown }> {
  const headers: Record<string, string> = {};
  if (opts.auth !== false) headers['Authorization'] = `Bearer ${ADMIN_TOKEN}`;
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

/** Insert one usage event (timestamped at insert time) via the awaitable path. */
async function seedEvent(): Promise<void> {
  await daemon.usageRecorder.recordAsync({
    providerId: 'mock',
    model: 'mock-model',
    apiKeyId: 'k1',
    sessionId: null,
    engineOrigin: 'completion',
    usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 },
  });
}

beforeEach(async () => {
  resetDaemonSingletonsForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-udash-admin-'));
  const configPath = join(tmpDir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        providers: [
          {
            id: 'mock',
            apiFormat: 'openai',
            baseUrl: 'http://127.0.0.1:1/v1',
            apiKey: '',
            apiKeys: [{ id: 'k1', apiKey: POOL_KEY_SECRET, label: 'Primary Key' }],
            models: ['mock-model'],
          },
        ],
        server: { enabled: false, networkBinding: false, port: 0, endpoints: [] },
        admin: { port: 0, token: ADMIN_TOKEN },
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
});

afterEach(async () => {
  if (daemon) {
    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    daemon.apiKeyPool.dispose();
  }
  resetDaemonSingletonsForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ── Time-series ─────────────────────────────────────────────────────────────────

describe('GET /admin/api/usage/timeseries', () => {
  it('returns zero-filled ascending buckets spanning the range (bare array)', async () => {
    await seedEvent();
    // A 3-day window at day granularity → 3 or 4 buckets, all present, ascending.
    const start = Date.now() - 3 * 86_400_000;
    const end = Date.now() + 1000;
    const r = await adminFetch('GET', `/admin/api/usage/timeseries?startTs=${start}&endTs=${end}&bucket=day`);
    expect(r.status).toBe(200);
    const rows = r.json as UsageTimeSeriesBucket[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // Ascending by bucketStartTs; every bucket has the frozen field set.
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].bucketStartTs).toBeGreaterThan(rows[i - 1].bucketStartTs);
    }
    for (const b of rows) {
      expect(typeof b.label).toBe('string');
      expect(typeof b.requests).toBe('number');
      expect(typeof b.inputTokens).toBe('number');
      expect(typeof b.costUsd).toBe('number');
    }
    // The seeded event contributes at least one request across the window.
    expect(rows.reduce((n, b) => n + b.requests, 0)).toBeGreaterThanOrEqual(1);
  });

  it('400s a missing or invalid bucket', async () => {
    const range = `startTs=0&endTs=${Date.now()}`;
    for (const qs of [range, `${range}&bucket=`, `${range}&bucket=week`, `${range}&bucket=DAY`]) {
      const r = await adminFetch('GET', `/admin/api/usage/timeseries?${qs}`);
      expect(r.status).toBe(400);
    }
  });

  it('400s a missing/non-numeric range (reuses parseRange)', async () => {
    for (const qs of ['bucket=day', 'startTs=0&bucket=day', `startTs=abc&endTs=${Date.now()}&bucket=day`]) {
      const r = await adminFetch('GET', `/admin/api/usage/timeseries?${qs}`);
      expect(r.status).toBe(400);
    }
  });

  it('400s a pathological range (projected bucket count over the cap)', async () => {
    // ~10 years at hour granularity → ~87k buckets, far over the 2000 cap.
    const start = Date.now() - 10 * 365 * 86_400_000;
    const end = Date.now();
    const r = await adminFetch('GET', `/admin/api/usage/timeseries?startTs=${start}&endTs=${end}&bucket=hour`);
    expect(r.status).toBe(400);
    expect((r.json as { error: { message: string } }).error.message).toMatch(/buckets/);
  });

  it('clamps a future endTs to now (coarse bucket → bounded result, no error)', async () => {
    const start = Date.now() - 86_400_000;
    const end = Date.now() + 100 * 365 * 86_400_000; // absurd future, but coarse month bucket
    const r = await adminFetch('GET', `/admin/api/usage/timeseries?startTs=${start}&endTs=${end}&bucket=month`);
    expect(r.status).toBe(200);
    const rows = r.json as UsageTimeSeriesBucket[];
    // Clamped to now → at most a couple of month buckets, never a runaway array.
    expect(rows.length).toBeLessThanOrEqual(3);
  });
});

// ── Dashboard summary ────────────────────────────────────────────────────────────

interface DashboardBody {
  today: { eventCount: number; inputTokens: number };
  total: { eventCount: number; inputTokens: number };
  providers: { total: number; enabled: number };
  outboundKeys: { total: number; active: number };
  accounts: { total: number; byProvider: Record<string, number> };
  server: { running: boolean; port: number; uptimeMs: number };
  generatedAt: number;
}

describe('GET /admin/api/dashboard', () => {
  it('summarizes totals, provider/key/account counts, and live server status', async () => {
    // Seed usage (contributes to both today and total).
    await seedEvent();
    await seedEvent();

    // A disabled second provider so enabled < total.
    await adminFetch('POST', '/admin/api/providers', {
      id: 'mock2',
      apiFormat: 'openai',
      baseUrl: 'http://127.0.0.1:2/v1',
      apiKey: 'sk-x',
      enabled: false,
    });

    // Three outbound keys: one revoked, one disabled, one active.
    const k1 = (await adminFetch('POST', '/admin/api/keys', { name: 'k-active' })).json as { id: string };
    const k2 = (await adminFetch('POST', '/admin/api/keys', { name: 'k-revoked' })).json as { id: string };
    const k3 = (await adminFetch('POST', '/admin/api/keys', { name: 'k-disabled' })).json as { id: string };
    await adminFetch('POST', `/admin/api/keys/${k2.id}/revoke`);
    await adminFetch('POST', `/admin/api/keys/${k3.id}/enabled`, { enabled: false });
    void k1;

    // Start the outbound server so `server.running` is true.
    await daemon.outboundApiServer.applyConfig({
      enabled: true,
      networkBinding: false,
      port: 0,
      endpoints: [{ endpoint: 'chat', models: ['mock,mock-model'], useSubscription: false }],
    });

    const r = await adminFetch('GET', '/admin/api/dashboard');
    expect(r.status).toBe(200);
    const body = r.json as DashboardBody;

    // Usage: today ⊆ total; both saw the 2 seeded events.
    expect(body.total.eventCount).toBeGreaterThanOrEqual(2);
    expect(body.today.eventCount).toBeGreaterThanOrEqual(2);
    expect(body.total.eventCount).toBeGreaterThanOrEqual(body.today.eventCount);
    expect(body.total.inputTokens).toBeGreaterThanOrEqual(body.today.inputTokens);

    // Providers: 2 total, 1 enabled (mock2 disabled). Cross-check against GET.
    const provList = (await adminFetch('GET', '/admin/api/providers')).json as {
      providers: Array<{ enabled: boolean }>;
    };
    expect(body.providers.total).toBe(provList.providers.length);
    expect(body.providers.enabled).toBe(provList.providers.filter((p) => p.enabled).length);
    expect(body.providers.total).toBeGreaterThan(body.providers.enabled);

    // Outbound keys: 3 total, 1 active.
    expect(body.outboundKeys.total).toBe(3);
    expect(body.outboundKeys.active).toBe(1);

    // Accounts: consistent with the live lister; byProvider counts never exceed total.
    const acctList = (await adminFetch('GET', '/admin/api/accounts')).json as { accounts: unknown[] };
    expect(body.accounts.total).toBe(acctList.accounts.length);
    const byProviderSum = Object.values(body.accounts.byProvider).reduce((n, c) => n + c, 0);
    expect(byProviderSum).toBeLessThanOrEqual(body.accounts.total);

    // Server: reflects the live status; uptime non-negative; generatedAt ≈ now.
    const live = daemon.outboundApiServer.getStatus();
    expect(body.server.running).toBe(live.running);
    expect(body.server.running).toBe(true);
    expect(body.server.port).toBe(live.port);
    expect(body.server.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(Math.abs(body.generatedAt - Date.now())).toBeLessThan(60_000);
  });

  it('reports running:false + port 0 when the outbound server is stopped', async () => {
    const r = await adminFetch('GET', '/admin/api/dashboard');
    expect(r.status).toBe(200);
    const body = r.json as DashboardBody;
    expect(body.server.running).toBe(false);
    expect(body.server.port).toBe(0);
  });

  it('is SECRET-FREE (no pool key, admin token, keyHash, or token fields)', async () => {
    await adminFetch('POST', '/admin/api/keys', { name: 'scan' });
    const r = await adminFetch('GET', '/admin/api/dashboard');
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(POOL_KEY_SECRET);
    expect(r.text).not.toContain(ADMIN_TOKEN);
    expect(r.text).not.toContain('keyHash');
    expect(r.text).not.toContain('apiKey');
    expect(r.text).not.toContain('accessToken');
    expect(r.text).not.toContain('refreshToken');
  });

  it('405s a non-GET method', async () => {
    const r = await adminFetch('POST', '/admin/api/dashboard', {});
    expect(r.status).toBe(405);
  });

  it('401s without the admin token', async () => {
    const r = await adminFetch('GET', '/admin/api/dashboard', undefined, { auth: false });
    expect(r.status).toBe(401);
  });
});
