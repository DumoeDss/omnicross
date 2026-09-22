/**
 * admin-upstream-routing.test.ts — the upstream routing model's admin surface
 * and end-to-end gateway behavior (P2, docs/design/upstream-routing-model.md).
 *
 * Flow under test: a key created via POST /admin/api/keys materializes the
 * configured default upstream binding; an unbound key answers 403 at the
 * gateway; binding an upstream (POST /keys/:id/upstream-binding) derives
 * per-endpoint routes that SERVE real traffic (mock upstream), with the
 * upstream's mapping table driving model-name resolution; legacy keys
 * (no upstreamBinding) keep the stored-route semantics; `null` rolls a key
 * back to legacy.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadServerConfig } from '@omnicross/core/outbound-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assembledGatewayBindings } from '../admin/upstreamRoutingAdmin';
import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

const PROVIDER_REAL_KEY = 'sk-mock-upstream-real';

const CANNED_COMPLETION = {
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  created: 1,
  model: 'mock-model',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'pong' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

interface MockUpstream {
  server: HttpServer;
  port: number;
  hits: number;
  lastModel: string | undefined;
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = {
    server: undefined as unknown as HttpServer,
    port: 0,
    hits: 0,
    lastModel: undefined,
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.hits += 1;
      try {
        state.lastModel = (JSON.parse(body) as { model?: string }).model;
      } catch {
        state.lastModel = undefined;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(CANNED_COMPLETION));
    });
  });
  state.server = server;
  return new Promise((resolve) => {
    server.listen(
      0,
      '127.0.0.1',
      () => {
        state.port = (server.address() as AddressInfo).port;
        resolve(state);
      },
    );
  });
}

function stopServer(server: HttpServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

let tmpDir: string;
let upstream: MockUpstream;
let daemon: Daemon;
let gatewayBase: string;
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
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

async function gatewayChat(
  key: string,
  model = 'mock-model',
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${gatewayBase}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }] }),
  });
  return { status: res.status, text: await res.text() };
}

beforeEach(async () => {
  resetDaemonSingletonsForTests();
  upstream = await startMockUpstream();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-upstream-routing-'));

  const configPath = join(tmpDir, 'config.json');
  const providerBase = `http://127.0.0.1:${upstream.port}/v1`;
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        providers: [
          {
            id: 'mock',
            apiFormat: 'openai',
            baseUrl: providerBase,
            apiKey: PROVIDER_REAL_KEY,
            models: ['mock-model'],
          },
        ],
        server: {
          enabled: true,
          networkBinding: false,
          port: 0,
          // A legacy all-scope chat route (projected from the endpoint block)
          // keeps LEGACY keys served during the transition.
          endpoints: [{ endpoint: 'chat', models: ['mock,mock-model'], useSubscription: false }],
        },
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
  await daemon.providerProxy.start();

  // Mirror commands/start: boot applies the DERIVED aggregate, not the stored
  // routes alone.
  const serverConfig = await loadServerConfig(daemon.settingsStore);
  await daemon.outboundApiServer.applyConfig({
    enabled: true,
    networkBinding: serverConfig.networkBinding,
    endpoints: serverConfig.endpoints,
    bindings: await assembledGatewayBindings(daemon, serverConfig),
    port: serverConfig.port,
  });
  await daemon.adminServer.start();

  gatewayBase = daemon.outboundApiServer.getStatus().loopbackUrl as string;
  adminBase = daemon.adminServer.getStatus().url as string;
});

afterEach(async () => {
  resetDaemonSingletonsForTests();
  await daemon.adminServer.stop();
  await daemon.outboundApiServer.stop();
  await daemon.providerProxy.stop();
  daemon.apiKeyPool.dispose();
  await stopServer(upstream.server);
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

interface CreatedKey {
  id: string;
  plaintextOnce: string;
}

async function createKeyViaAdmin(): Promise<CreatedKey> {
  const r = await adminFetch('POST', '/admin/api/keys', { name: 'routing' });
  expect(r.status).toBe(201);
  const out = r.json as CreatedKey;
  expect(out.plaintextOnce).toBeTruthy();
  return out;
}

describe('upstream routing model (admin surface + gateway e2e)', () => {
  it('new keys materialize the default binding; unbound keys 403 at the gateway', async () => {
    const key = await createKeyViaAdmin();
    // Default setting is 'none' ⇒ explicit empty list.
    expect((key as CreatedKey & { upstreamBinding?: unknown }).upstreamBinding).toEqual({
      mode: 'explicit',
      targets: [],
    });

    const denied = await gatewayChat(key.plaintextOnce);
    expect(denied.status).toBe(403);
    expect(denied.text).toMatch(/no upstream bound/i);
    expect(upstream.hits).toBe(0);
  });

  it('binding an upstream derives per-endpoint routes that serve real traffic', async () => {
    const key = await createKeyViaAdmin();
    const bind = await adminFetch('POST', `/admin/api/keys/${key.id}/upstream-binding`, {
      binding: { mode: 'explicit', targets: [{ kind: 'provider', providerId: 'mock' }] },
    });
    expect(bind.status).toBe(200);

    // The derived aggregate is visible on the catalog surface.
    const catalog = await adminFetch('GET', '/admin/api/upstreams');
    expect(catalog.status).toBe(200);
    const live = (catalog.json as { liveBindings: Array<{ id: string }> }).liveBindings;
    expect(live.some((b) => b.id === `keyup:${key.id}:0:chat`)).toBe(true);
    expect(live.some((b) => b.id === `keyup:${key.id}:0:messages`)).toBe(true);

    // Missing stored tables inherit defaults on both GET and live dispatch.
    expect((catalog.json as { upstreams: Array<{ key: string; mappings: unknown[] }> }).upstreams[0].mappings)
      .toContainEqual({ source: '*', target: 'mock-model' });
    const served = await gatewayChat(key.plaintextOnce, 'a-new-client-model');
    expect(served.status).toBe(200);
    expect(upstream.hits).toBeGreaterThan(0);
    expect(upstream.lastModel).toBe('mock-model');
  });

  it('an explicitly cleared table remains passthrough after reload and live reapplication', async () => {
    const key = await createKeyViaAdmin();
    await adminFetch('POST', `/admin/api/keys/${key.id}/upstream-binding`, { binding: { mode: 'all' } });
    expect((await adminFetch('PUT', '/admin/api/upstreams/mock/mappings', { mappings: [] })).status).toBe(200);
    const saved = await loadServerConfig(daemon.settingsStore);
    expect(saved.upstreamModelMappings?.mock).toEqual([]);
    await adminFetch('PUT', '/admin/api/server', { defaultKeyUpstreamBinding: 'all' });
    expect((await adminFetch('POST', '/admin/api/upstreams/migrate-legacy')).status).toBe(200);
    const catalog = await adminFetch('GET', '/admin/api/upstreams');
    expect((catalog.json as { upstreams: Array<{ mappings: unknown[] }> }).upstreams[0].mappings).toEqual([]);
    expect((await gatewayChat(key.plaintextOnce, 'custom-native-model')).status).toBe(200);
    expect(upstream.lastModel).toBe('custom-native-model');
  });

  it('the upstream mapping table drives name resolution (exact-before-wildcard)', async () => {
    const table = await adminFetch('PUT', '/admin/api/upstreams/mock/mappings', {
      mappings: [{ source: 'gpt-*', target: 'mock-model' }],
    });
    expect(table.status).toBe(200);

    const key = await createKeyViaAdmin();
    await adminFetch('POST', `/admin/api/keys/${key.id}/upstream-binding`, {
      binding: { mode: 'all' },
    });

    // A wildcard-covered name resolves to the mapped target model upstream.
    const served = await gatewayChat(key.plaintextOnce, 'gpt-4o');
    expect(served.status).toBe(200);
    expect(upstream.lastModel).toBe('mock-model');

    // A name nothing declares → no candidate can serve → 404 (not 403: the
    // key IS bound; the model just does not exist anywhere in its set).
    const missing = await gatewayChat(key.plaintextOnce, 'no-such-model-anywhere');
    expect(missing.status).toBe(404);
  });

  it('rejects an invalid mapping table at the write edge (D5)', async () => {
    const bad = await adminFetch('PUT', '/admin/api/upstreams/mock/mappings', {
      mappings: [
        { source: 'gpt-4o', target: 'mock-model' },
        { source: 'claude-*', target: 'mock-model-2' },
      ],
    });
    expect(bad.status).toBe(400);
    expect(bad.text).toMatch(/wildcard/i);

    const unknown = await adminFetch('PUT', '/admin/api/upstreams/ghost/mappings', {
      mappings: [],
    });
    expect(unknown.status).toBe(404);
  });

  it('rejects upstream bindings to unknown upstreams', async () => {
    const key = await createKeyViaAdmin();
    const bad = await adminFetch('POST', `/admin/api/keys/${key.id}/upstream-binding`, {
      binding: { mode: 'explicit', targets: [{ kind: 'provider', providerId: 'ghost' }] },
    });
    expect(bad.status).toBe(400);
    expect(bad.text).toMatch(/unknown upstream/i);
  });

  it('legacy keys (no upstreamBinding) keep stored-route semantics; null rolls back', async () => {
    // A key created straight on the store never materialized a binding.
    const { createNamedKey } = await import('@omnicross/core/outbound-api');
    const legacy = await createNamedKey(daemon.keyDb, 'legacy');
    const served = await gatewayChat(legacy.plaintextOnce);
    expect(served.status).toBe(200);

    // A migrated key rolled back with null ALSO falls back to the legacy
    // all-scope route.
    const key = await createKeyViaAdmin();
    await adminFetch('POST', `/admin/api/keys/${key.id}/upstream-binding`, {
      binding: { mode: 'explicit', targets: [] },
    });
    const denied = await gatewayChat(key.plaintextOnce);
    expect(denied.status).toBe(403);

    const rollback = await adminFetch('POST', `/admin/api/keys/${key.id}/upstream-binding`, {
      binding: null,
    });
    expect(rollback.status).toBe(200);
    const afterRollback = await gatewayChat(key.plaintextOnce);
    expect(afterRollback.status).toBe(200);
  });

  it("the default-setting 'all' pre-selects the whole catalog as an explicit snapshot", async () => {
    const put = await adminFetch('PUT', '/admin/api/server', {
      defaultKeyUpstreamBinding: 'all',
    });
    expect(put.status).toBe(200);

    const key = await createKeyViaAdmin();
    // No live "all" mode: creation snapshots every CURRENT upstream explicitly.
    expect((key as CreatedKey & { upstreamBinding?: unknown }).upstreamBinding).toEqual({
      mode: 'explicit',
      targets: [{ kind: 'provider', providerId: 'mock' }],
    });
    const served = await gatewayChat(key.plaintextOnce);
    expect(served.status).toBe(200);
  });

  it('P4: migrate-legacy materializes key bindings + mapping tables; rollback restores', async () => {
    // A legacy key (created directly on the store — no upstreamBinding).
    const { createNamedKey } = await import('@omnicross/core/outbound-api');
    const legacy = await createNamedKey(daemon.keyDb, 'legacy-migrate');
    expect(await gatewayChat(legacy.plaintextOnce)).toMatchObject({ status: 200 });

    const migrate = await adminFetch('POST', '/admin/api/upstreams/migrate-legacy');
    expect(migrate.status).toBe(200);
    const result = migrate.json as {
      applied: boolean;
      keyBindings: Array<{ keyId: string }>;
      mappingTables: Record<string, Array<{ source: string }>>;
      emptyKeys: string[];
    };
    expect(result.applied).toBe(true);
    expect(result.keyBindings.some((entry) => entry.keyId === legacy.id)).toBe(true);
    // The legacy chat route (all-scope, models ['mock,mock-model']) became an
    // identity mapping row on the mock provider's table.
    expect(result.mappingTables.mock?.some((row) => row.source === 'mock-model')).toBe(true);

    // The migrated key still serves (derived binding to the mock provider).
    expect(await gatewayChat(legacy.plaintextOnce)).toMatchObject({ status: 200 });

    // Idempotent: a second run has nothing left to convert.
    const again = await adminFetch('POST', '/admin/api/upstreams/migrate-legacy');
    expect((again.json as { applied: boolean }).applied).toBe(false);

    // Rollback: every key's binding clears; the legacy route serves again.
    const rollback = await adminFetch('POST', '/admin/api/upstreams/rollback-legacy');
    expect(rollback.status).toBe(200);
    expect((rollback.json as { cleared: number }).cleared).toBeGreaterThan(0);
    expect(await gatewayChat(legacy.plaintextOnce)).toMatchObject({ status: 200 });
  });
});
