/**
 * admin-presets.test.ts — `GET /admin/api/presets` + the dashboard prefill→write
 * path (design D5). Boots the full daemon in process (mirrors
 * `admin-dashboard.test.ts`).
 *
 * Asserts: the GET returns only the whitelist DTO (no transformer/searchConfig/
 * apiKey), apiFormat is the NARROWED daemon format (google→gemini), excluded[]
 * carries reasons, and a preset-prefilled POST through the EXISTING
 * `/admin/api/providers` path lands a hot-reloaded row whose key is masked on the
 * next GET and persisted to config.json.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadServerConfig } from '@omnicross/core/outbound-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

const CANNED_COMPLETION = {
  id: 'chatcmpl-presets-mock',
  object: 'chat.completion',
  created: 1,
  model: 'mock-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const PROVIDER_SENTINEL_KEY = 'sk-provider-SENTINEL-presets';

interface MockUpstream {
  server: Server;
  port: number;
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = { server: undefined as unknown as Server, port: 0 };
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(CANNED_COMPLETION));
    });
  });
  state.server = server;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.port = (server.address() as AddressInfo).port;
      resolve(state);
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

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
let upstream: MockUpstream;
let daemon: Daemon;
let configPath: string;

function writeConfig(path: string, providerBase: string): void {
  const cfg = {
    providers: [
      { id: 'mock', apiFormat: 'openai', baseUrl: providerBase, apiKey: PROVIDER_SENTINEL_KEY, models: ['mock-model'] },
    ],
    server: {
      enabled: true,
      networkBinding: false,
      port: 0,
      endpoints: [
        { endpoint: 'chat', models: ['mock,mock-model'], useSubscription: false },
        // messages/responses need complete kind maps or the startup gate refuses to bind.
        { endpoint: 'responses', modelMap: { codex: 'mock,mock-model', mini: 'mock,mock-model' }, useSubscription: false },
        {
          endpoint: 'messages',
          modelMap: { fable: 'mock,mock-model', opus: 'mock,mock-model', sonnet: 'mock,mock-model', haiku: 'mock,mock-model' },
          useSubscription: false,
        },
      ],
    },
    admin: { port: 0 },
  };
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
}

beforeEach(async () => {
  resetDaemonSingletonsForTests();
  upstream = await startMockUpstream();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-presets-'));
  configPath = join(tmpDir, 'config.json');
  const keysPath = join(tmpDir, 'keys.json');
  const tokensPath = join(tmpDir, 'tokens.json');
  writeConfig(configPath, `http://127.0.0.1:${upstream.port}/v1`);

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
});

afterEach(async () => {
  if (daemon) {
    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose(); // stop the pool's cooldown-cleanup interval
  }
  if (upstream) await stopServer(upstream.server);
  resetDaemonSingletonsForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /admin/api/presets', () => {
  it('returns a whitelist DTO with no extra/secret fields', async () => {
    const r = await adminFetch('GET', '/admin/api/presets');
    expect(r.status).toBe(200);
    const body = r.json as {
      presets: Array<Record<string, unknown>>;
      excluded: Array<{ id: string; reason: string }>;
    };
    expect(Array.isArray(body.presets)).toBe(true);
    expect(body.presets.length).toBeGreaterThan(20);
    const allowed = ['id', 'presetId', 'name', 'apiFormat', 'baseUrl', 'models'].sort();
    for (const p of body.presets) {
      expect(Object.keys(p).sort()).toEqual(allowed);
    }
    // No leaked full-template fields in the projected presets (the `excluded[]`
    // reasons legitimately mention "transformer" as prose, so scope the key-leak
    // net to the presets projection rather than the whole response text).
    const presetsJson = JSON.stringify(body.presets);
    expect(presetsJson).not.toContain('transformer');
    expect(presetsJson).not.toContain('searchConfig');
    expect(presetsJson).not.toContain('apiModes');
    expect(presetsJson).not.toContain('apiKey');
  });

  it('narrows apiFormat (google→gemini) and lists excluded with reasons', async () => {
    const r = await adminFetch('GET', '/admin/api/presets');
    const body = r.json as {
      presets: Array<{ id: string; apiFormat: string }>;
      excluded: Array<{ id: string; reason: string }>;
    };
    // No mappable preset carries the wide 'google' value.
    for (const p of body.presets) {
      expect(['openai', 'anthropic', 'gemini']).toContain(p.apiFormat);
    }
    const gemini = body.presets.find((p) => p.id === 'gemini');
    expect(gemini?.apiFormat).toBe('gemini');
    const excludedIds = body.excluded.map((e) => e.id);
    expect(excludedIds).toContain('openai-response');
    expect(excludedIds).toContain('azure-openai');
    for (const e of body.excluded) expect(e.reason.length).toBeGreaterThan(0);
  });

  it('405s a non-GET', async () => {
    const r = await adminFetch('POST', '/admin/api/presets', {});
    expect(r.status).toBe(405);
  });
});

describe('dashboard prefill → existing provider write path', () => {
  it('a preset-prefilled POST lands a hot-reloaded, masked, persisted row', async () => {
    // Read the preset DTO the dashboard would prefill from.
    const presetsRes = await adminFetch('GET', '/admin/api/presets');
    const presets = (presetsRes.json as { presets: Array<{ id: string; apiFormat: string; baseUrl: string; models: string[] }> }).presets;
    const deepseek = presets.find((p) => p.id === 'deepseek') ?? presets[0];

    // Emulate saveProvider(): prefilled format/baseUrl/models + a user key, via
    // the EXISTING POST /admin/api/providers (no preset write endpoint).
    const created = await adminFetch('POST', '/admin/api/providers', {
      id: 'from-preset',
      apiFormat: deepseek.apiFormat,
      baseUrl: deepseek.baseUrl,
      apiKey: 'sk-userkey-SENTINEL',
      models: deepseek.models,
    });
    expect(created.status).toBe(201);

    // GET providers → masked key, models carried.
    const list = await adminFetch('GET', '/admin/api/providers');
    expect(list.text).not.toContain('sk-userkey-SENTINEL');
    const row = (list.json as { providers: Array<Record<string, unknown>> }).providers.find((p) => p['id'] === 'from-preset')!;
    expect(row).toBeTruthy();
    expect(row['hasApiKey']).toBe(true);
    expect((row['models'] as string[]).length).toBe(deepseek.models.length);

    // Hot-reloaded into the live catalog (no restart).
    const live = await daemon.llmConfig.getProvider('from-preset');
    expect(live?.id).toBe('from-preset');

    // Persisted to config.json on disk.
    const onDisk = loadConfig(configPath);
    expect(onDisk.providers.some((p) => p.id === 'from-preset')).toBe(true);
  });
});
