/**
 * health-endpoint.test.ts — the unauthenticated `/health` probe end-to-end
 * (daemon-health-endpoint).
 *
 * Boots the daemon in process (mirrors `admin-dashboard.test.ts`) with an
 * `admin.token` set AND sentinel secrets seeded, then proves:
 *  - `GET /health` on the ADMIN port reaches the report WITHOUT a token, even
 *    though `admin.token` is configured (real liveness probe).
 *  - `GET /health` on the OUTBOUND traffic port bypasses key-auth.
 *  - the report leaks NO seeded secret (provider key / sub tokens / admin token).
 *  - a stopped outbound server flips `/health` to 503 (probe-friendly not-ready).
 *  - `HEAD /health` returns headers only (no body).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadServerConfig } from '@omnicross/core/outbound-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

const PROVIDER_SENTINEL_KEY = 'sk-provider-SENTINEL-health-zzz9';
const SENTINEL_SUB_ACCESS_TOKEN = 'SENTINEL-SUB-ACCESS-TOKEN-health';
const SENTINEL_SUB_REFRESH_TOKEN = 'SENTINEL-SUB-REFRESH-TOKEN-health';
const ADMIN_TOKEN = 'SENTINEL-ADMIN-TOKEN-health';

let tmpDir: string;
let daemon: Daemon;
let adminBase: string;
let outboundBase: string;

function writeConfig(configPath: string): void {
  const cfg = {
    providers: [
      { id: 'mock', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: PROVIDER_SENTINEL_KEY, models: ['mock-model'] },
    ],
    server: {
      enabled: true,
      networkBinding: false,
      port: 0,
      endpoints: [
        { endpoint: 'chat', models: ['mock,mock-model'], useSubscription: false },
        { endpoint: 'responses', modelMap: { codex: 'mock,mock-model', mini: 'mock,mock-model' }, useSubscription: false },
        {
          endpoint: 'messages',
          modelMap: { fable: 'mock,mock-model', opus: 'mock,mock-model', sonnet: 'mock,mock-model', haiku: 'mock,mock-model' },
          useSubscription: false,
        },
      ],
    },
    admin: { port: 0, token: ADMIN_TOKEN },
  };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

function writeTokens(tokensPath: string): void {
  writeFileSync(
    tokensPath,
    JSON.stringify(
      {
        codex: {
          authMethod: 'oauth',
          status: 'authorized',
          accessToken: SENTINEL_SUB_ACCESS_TOKEN,
          refreshToken: SENTINEL_SUB_REFRESH_TOKEN,
        },
        updatedAt: '2026-06-03T00:00:00.000Z',
      },
      null,
      2,
    ),
    'utf8',
  );
}

beforeEach(async () => {
  resetDaemonSingletonsForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-health-'));
  const configPath = join(tmpDir, 'config.json');
  const keysPath = join(tmpDir, 'keys.json');
  const tokensPath = join(tmpDir, 'tokens.json');
  writeConfig(configPath);
  writeTokens(tokensPath);

  const config = loadConfig(configPath);
  daemon = buildDaemon(config, { configPath, keysPath, tokensPath, masterKeyFilePath: join(tmpDir, 'master.key') });
  await daemon.llmConfig.ready();
  await daemon.providerProxy.start();
  const serverConfig = await loadServerConfig(daemon.settingsStore);
  await daemon.outboundApiServer.applyConfig({
    enabled: true,
    networkBinding: serverConfig.networkBinding,
    endpoints: serverConfig.endpoints,
    port: serverConfig.port,
  });
  await daemon.adminServer.start();
  adminBase = daemon.adminServer.getStatus().url as string;
  outboundBase = daemon.outboundApiServer.getStatus().loopbackUrl as string;
});

afterEach(async () => {
  if (daemon) {
    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
  }
  resetDaemonSingletonsForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('/health on the admin server (unauthenticated)', () => {
  it('returns 200 + report WITHOUT a token, even though admin.token is set', async () => {
    // Sanity: the admin API IS gated (401 without the bearer).
    const gated = await fetch(`${adminBase}/admin/api/status`);
    expect(gated.status).toBe(401);

    // But /health is reachable with NO Authorization header.
    const res = await fetch(`${adminBase}/health`);
    expect(res.status).toBe(200);
    const report = (await res.json()) as { status: string; version: string; checks: Record<string, boolean> };
    expect(report.status).toBe('ok');
    expect(typeof report.version).toBe('string');
    expect(report.checks.config).toBe(true);
    expect(report.checks.credentialStore).toBe(true);
    expect(report.checks.outboundServer).toBe(true);
    expect(report.checks.adminServer).toBe(true);
  });

  it('/healthz is an alias', async () => {
    const res = await fetch(`${adminBase}/healthz`);
    expect(res.status).toBe(200);
  });

  it('tolerates a trailing slash (/health/) unauthenticated → 200', async () => {
    const res = await fetch(`${adminBase}/health/`);
    expect(res.status).toBe(200);
    const report = (await res.json()) as { status: string };
    expect(report.status).toBe('ok');
  });

  it('HEAD /health returns headers only (no body)', async () => {
    const res = await fetch(`${adminBase}/health`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('leaks NO seeded secret (provider key / sub tokens / admin token)', async () => {
    const text = await (await fetch(`${adminBase}/health`)).text();
    expect(text).not.toContain(PROVIDER_SENTINEL_KEY);
    expect(text).not.toContain(SENTINEL_SUB_ACCESS_TOKEN);
    expect(text).not.toContain(SENTINEL_SUB_REFRESH_TOKEN);
    expect(text).not.toContain(ADMIN_TOKEN);
  });

  it('flips to 503 when the outbound server is stopped (not-ready)', async () => {
    await daemon.outboundApiServer.stop();
    const res = await fetch(`${adminBase}/health`);
    expect(res.status).toBe(503);
    const report = (await res.json()) as { status: string; checks: Record<string, boolean> };
    expect(report.status).toBe('degraded');
    expect(report.checks.outboundServer).toBe(false);
  });
});

describe('/health on the outbound traffic server (bypasses key-auth)', () => {
  it('returns 200 with NO API key', async () => {
    // Sanity: a normal outbound request with no key is 401.
    const gated = await fetch(`${outboundBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', messages: [] }),
    });
    expect(gated.status).toBe(401);

    const res = await fetch(`${outboundBase}/health`);
    expect(res.status).toBe(200);
    const report = (await res.json()) as { status: string };
    expect(report.status).toBe('ok');
  });

  it('leaks no seeded secret on the traffic port either', async () => {
    const text = await (await fetch(`${outboundBase}/healthz`)).text();
    expect(text).not.toContain(PROVIDER_SENTINEL_KEY);
    expect(text).not.toContain(SENTINEL_SUB_ACCESS_TOKEN);
    expect(text).not.toContain(ADMIN_TOKEN);
  });
});
