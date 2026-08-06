/**
 * admin-server-kind-config.test.ts — the model-kind-mapping surface additions to
 * the `/admin/api/server` + `/admin/api/status` routes.
 *
 * Covers:
 *  - `GET /status` CLASS-AWARE projection: kind-mapped endpoints (`messages`/
 *    `responses`) project a `kinds` map (their `modelMap`), NOT a `model`;
 *    role-based endpoints (`chat`/`gemini`) still project `model` (defaultModel).
 *  - `PUT /server` enable: routing lives in downstream routes, so an endpoint
 *    with no route that can serve simply 503s per-request — enabling never
 *    refuses to bind over model completeness.
 *
 * Boots the FULL daemon in-process (mirrors admin-provider-endpoints.test.ts).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

// ── Admin fetch helper ────────────────────────────────────────────────────────

let adminBase: string;

async function adminFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
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
  return { status: res.status, json };
}

// ── Fixture ───────────────────────────────────────────────────────────────────

let tmpDir: string;
let daemon: Daemon;

interface EndpointBlock {
  endpoint: string;
  modelMap?: Record<string, string>;
  models?: string[];
  defaultModel?: string;
  backgroundModel?: string;
  useSubscription: boolean;
}

/** Write a config whose outbound server starts DISABLED (driven via admin PUTs). */
function writeConfig(configPath: string, endpoints: EndpointBlock[]): void {
  const cfg = {
    providers: [
      { id: 'a', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-a', models: ['mock-model'] },
    ],
    server: { enabled: false, networkBinding: false, port: 0, endpoints },
    admin: { port: 0 },
  };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

async function bootDaemon(endpoints: EndpointBlock[]): Promise<void> {
  resetDaemonSingletonsForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-kindcfg-'));
  const configPath = join(tmpDir, 'config.json');
  writeConfig(configPath, endpoints);
  const config = loadConfig(configPath);
  daemon = buildDaemon(config, {
    configPath,
    keysPath: join(tmpDir, 'keys.json'),
    tokensPath: join(tmpDir, 'tokens.json'),
    masterKeyFilePath: join(tmpDir, 'master.key'),
  });
  await daemon.llmConfig.ready();
  await daemon.providerProxy.start();
  // Outbound server stays stopped at boot (enabled:false) — admin PUTs drive it.
  await daemon.adminServer.start();
  adminBase = daemon.adminServer.getStatus().url as string;
}

/** The four endpoints fully mapped (every kind set). */
function completeEndpoints(): EndpointBlock[] {
  return [
    { endpoint: 'chat', models: ['a,mock-model'], useSubscription: false },
    { endpoint: 'responses', modelMap: { codex: 'a,mock-model', mini: 'a,mock-model' }, useSubscription: false },
    {
      endpoint: 'messages',
      modelMap: { fable: 'a,mock-model', opus: 'a,mock-model', sonnet: 'a,mock-model', haiku: 'a,mock-model' },
      useSubscription: false,
    },
    { endpoint: 'gemini', defaultModel: 'a,mock-model', backgroundModel: 'a,mock-model', useSubscription: false },
  ];
}

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

interface StatusEndpoint {
  endpoint: string;
  model?: string;
  kinds?: Record<string, string>;
  models?: string[];
  useSubscription: boolean;
}

// ── Status projection ──────────────────────────────────────────────────────────

describe('GET /status class-aware endpoint projection', () => {
  it('projects `kinds` for messages/responses and `model` for chat/gemini', async () => {
    await bootDaemon(completeEndpoints());
    const r = await adminFetch('GET', '/admin/api/status');
    const endpoints = (r.json as { endpoints: StatusEndpoint[] }).endpoints;

    const messages = endpoints.find((e) => e.endpoint === 'messages')!;
    expect(messages.kinds).toEqual({
      fable: 'a,mock-model',
      opus: 'a,mock-model',
      sonnet: 'a,mock-model',
      haiku: 'a,mock-model',
    });
    expect(messages.model).toBeUndefined();

    const responses = endpoints.find((e) => e.endpoint === 'responses')!;
    expect(responses.kinds).toEqual({ codex: 'a,mock-model', mini: 'a,mock-model' });

    const chat = endpoints.find((e) => e.endpoint === 'chat')!;
    expect(chat.models).toEqual(['a,mock-model']);
    expect(chat.model).toBeUndefined();
    expect(chat.kinds).toBeUndefined();

    const gemini = endpoints.find((e) => e.endpoint === 'gemini')!;
    expect(gemini.model).toBe('a,mock-model');
  });
});

// ── Enable binds regardless of model completeness ────────────────────────────

describe('PUT /server enable', () => {
  it('enabling a fully-mapped config binds normally (no error envelope)', async () => {
    await bootDaemon(completeEndpoints());

    const put = await adminFetch('PUT', '/admin/api/server', { enabled: true });
    expect(put.status).toBe(200);
    const body = put.json as { server: { enabled: boolean }; error?: unknown };
    expect(body.error).toBeUndefined();
    expect(body.server.enabled).toBe(true);

    const status = await adminFetch('GET', '/admin/api/status');
    const s = status.json as { running: boolean; port: number };
    expect(s.running).toBe(true);
    expect(s.port).toBeGreaterThan(0);
  });


  it('one endpoint configured + the other blank → binds (unused endpoint allowed)', async () => {
    // The operator uses ONLY Claude Code (messages configured); Codex
    // (responses) is entirely unmapped → no route covers it, the server still
    // starts, and responses requests 503 per-request.
    const messagesOnly: EndpointBlock[] = completeEndpoints().map((e) =>
      e.endpoint === 'responses'
        ? { endpoint: 'responses', modelMap: { codex: '', mini: '' }, useSubscription: false }
        : e,
    );
    await bootDaemon(messagesOnly);

    const put = await adminFetch('PUT', '/admin/api/server', { enabled: true });
    expect(put.status).toBe(200);
    expect((put.json as { error?: unknown }).error).toBeUndefined();

    const status = await adminFetch('GET', '/admin/api/status');
    expect((status.json as { running: boolean }).running).toBe(true);
  });
});
