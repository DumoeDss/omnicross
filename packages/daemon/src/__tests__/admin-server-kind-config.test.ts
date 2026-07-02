/**
 * admin-server-kind-config.test.ts — the model-kind-mapping surface additions to
 * the `/admin/api/server` + `/admin/api/status` routes.
 *
 * Covers:
 *  - `GET /status` CLASS-AWARE projection: kind-mapped endpoints (`messages`/
 *    `responses`) project a `kinds` map (their `modelMap`), NOT a `model`;
 *    role-based endpoints (`chat`/`gemini`) still project `model` (defaultModel).
 *  - `PUT /server` STARTUP GATE: enabling with an incomplete kind map persists
 *    the partial config but does NOT bind, and returns the actionable
 *    `{ error: { code:'incomplete-model-config', missing } }` envelope (HTTP 200).
 *  - A fully-mapped enable binds normally (no error envelope, server running).
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

/**
 * The four endpoints with messages/responses PARTIALLY mapped (some kinds set,
 * some blank) — the config-mistake shape the startup gate blocks. (A FULLY
 * blank kind map means "endpoint unused" and does NOT block — see the
 * partial-config test below.)
 */
function incompleteEndpoints(): EndpointBlock[] {
  return [
    { endpoint: 'chat', defaultModel: 'a,mock-model', backgroundModel: 'a,mock-model', useSubscription: false },
    { endpoint: 'responses', modelMap: { codex: 'a,mock-model', mini: '' }, useSubscription: false },
    {
      endpoint: 'messages',
      modelMap: { fable: '', opus: '', sonnet: 'a,mock-model', haiku: '' },
      useSubscription: false,
    },
    { endpoint: 'gemini', defaultModel: 'a,mock-model', backgroundModel: 'a,mock-model', useSubscription: false },
  ];
}

/** The four endpoints fully mapped (every kind set). */
function completeEndpoints(): EndpointBlock[] {
  return [
    { endpoint: 'chat', defaultModel: 'a,mock-model', backgroundModel: 'a,mock-model', useSubscription: false },
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
    expect(chat.model).toBe('a,mock-model');
    expect(chat.kinds).toBeUndefined();

    const gemini = endpoints.find((e) => e.endpoint === 'gemini')!;
    expect(gemini.model).toBe('a,mock-model');
  });
});

// ── Startup gate ────────────────────────────────────────────────────────────────

describe('PUT /server startup gate (incomplete kind map)', () => {
  it('enabling an incomplete config persists it but does not bind, returning the missing kinds', async () => {
    await bootDaemon(incompleteEndpoints());

    const put = await adminFetch('PUT', '/admin/api/server', { enabled: true });
    expect(put.status).toBe(200);
    const body = put.json as {
      server: { enabled: boolean };
      error?: { code: string; missing: Array<{ endpoint: string; missingKinds: string[] }> };
    };
    expect(body.error?.code).toBe('incomplete-model-config');

    const byEndpoint = new Map(body.error!.missing.map((m) => [m.endpoint, m.missingKinds]));
    expect(byEndpoint.get('messages')).toEqual(['fable', 'opus', 'haiku']);
    expect(byEndpoint.get('responses')).toEqual(['mini']);

    // Partial config retained (enabled:true persisted) …
    expect(body.server.enabled).toBe(true);
    const cfg = await adminFetch('GET', '/admin/api/server');
    expect((cfg.json as { server: { enabled: boolean } }).server.enabled).toBe(true);

    // … but the listener never bound.
    const status = await adminFetch('GET', '/admin/api/status');
    expect((status.json as { running: boolean }).running).toBe(false);
  });

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

  it('reconfiguring a RUNNING server to an incomplete map tears down the listener (no stale serving)', async () => {
    await bootDaemon(completeEndpoints());

    // Enable with a complete config → the listener binds.
    const enable = await adminFetch('PUT', '/admin/api/server', { enabled: true });
    expect(enable.status).toBe(200);
    expect((enable.json as { error?: unknown }).error).toBeUndefined();
    const running = await adminFetch('GET', '/admin/api/status');
    expect((running.json as { running: boolean }).running).toBe(true);

    // Now reconfigure `messages` to a PARTIAL kind map (a config mistake — a
    // fully-blank map would mean "unused" and is allowed) while still enabled.
    const incompleteMessages: EndpointBlock[] = completeEndpoints().map((e) =>
      e.endpoint === 'messages'
        ? { endpoint: 'messages', modelMap: { fable: '', opus: 'a,mock-model', sonnet: '', haiku: '' }, useSubscription: false }
        : e,
    );
    const put = await adminFetch('PUT', '/admin/api/server', { enabled: true, endpoints: incompleteMessages });
    expect(put.status).toBe(200);
    const body = put.json as { error?: { code: string; missing: Array<{ endpoint: string }> } };
    expect(body.error?.code).toBe('incomplete-model-config');
    expect(body.error!.missing.map((m) => m.endpoint)).toContain('messages');

    // The previously-bound listener was TORN DOWN — live state matches the
    // "cannot start" the UI shows (no stale mapping served).
    const after = await adminFetch('GET', '/admin/api/status');
    expect((after.json as { running: boolean }).running).toBe(false);
  });

  it('one endpoint fully configured + the other fully blank → binds (unused endpoint allowed)', async () => {
    // The operator uses ONLY Claude Code (messages configured); Codex
    // (responses) is entirely unmapped → treated as unused, the server still
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
