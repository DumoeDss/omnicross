/**
 * subscription-multi-account-boot-smoke.test.ts — the account-POOL serving proof
 * for `subscription-account-scheduling` (originally the `subscription-multi-account`
 * active-switch proof, task 11.4).
 *
 * Two claude accounts in tokens.json (each a distinct OAuth bearer). Since the
 * account-pool scheduler shipped, WHICH account serves a request is the selector's
 * job (priority → LRU, sticky per session), NOT the active pointer — so this proves
 * the NEW behavior: distinct conversations SPREAD across both bearers, while one
 * conversation (a repeated body → one session key) STICKS to a single bearer. REAL
 * core routing + REAL PassThroughAuthStrategy + REAL selector; ONLY the upstream is
 * mocked.
 *
 * (The pre-pool assertion "switching active pins all traffic to the active
 * bearer" is exactly what this feature changes — see design.md D1/D2 and
 * subscription-account-scheduling spec "Selected non-active account emits traffic
 * by id".)
 *
 * Sibling of `subscription-messages-boot-smoke.test.ts` (kept separate, not an
 * edit of it).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createNamedKey,
  type GatewayBinding,
  loadServerConfig,
} from '@omnicross/core/outbound-api';
import {
  setSubscriptionRegistryForOutbound,
  type SubscriptionRegistryLike,
} from '@omnicross/core/outbound-api/subscriptionRegistryPort';
import type { SubscriptionDispatchProfile } from '@omnicross/core/provider-proxy/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

const CANNED_RESPONSE = {
  id: 'msg-mock',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-5',
  content: [{ type: 'text', text: 'pong' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
};

const BEARER_A = 'fake-claude-token-ACCOUNT-A';
const BEARER_B = 'fake-claude-token-ACCOUNT-B';

interface MockUpstream {
  server: Server;
  port: number;
  lastAuthHeader: string | undefined;
  hits: number;
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = { server: undefined as unknown as Server, port: 0, lastAuthHeader: undefined, hits: 0 };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.hits += 1;
      state.lastAuthHeader = req.headers['authorization'] as string | undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(CANNED_RESPONSE));
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

let tmpDir: string;
let upstream: MockUpstream;
let daemon: Daemon;
let baseUrl: string;
let adminBase: string;
let plaintextKey: string;
let clientKeyId: string;
let accountAId: string;
let accountBId: string;

function overrideUpstreamUrl(d: Daemon, providerId: string, mockUrl: string): void {
  const real = d.subscriptionRegistry;
  const wrapper: SubscriptionRegistryLike = {
    getProfile(id: string): SubscriptionDispatchProfile | null {
      const profile = real.getProfile(id);
      if (!profile || id !== providerId) return profile;
      return { ...profile, resolveUpstreamUrl: () => mockUrl };
    },
  };
  setSubscriptionRegistryForOutbound(wrapper);
}

function writeConfig(configPath: string): void {
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        providers: [
          { id: 'mock-openai', apiFormat: 'openai', baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: 'sk-unused', models: ['mock-model'] },
        ],
        server: {
          enabled: true,
          networkBinding: false,
          port: 0,
          endpoints: [
            { endpoint: 'messages', modelMap: { fable: 'claude,claude-sonnet-4-5', opus: 'claude,claude-sonnet-4-5', sonnet: 'claude,claude-sonnet-4-5', haiku: 'claude,claude-sonnet-4-5' }, useSubscription: true },
            { endpoint: 'responses', modelMap: { codex: 'claude,claude-sonnet-4-5', mini: 'claude,claude-sonnet-4-5' }, useSubscription: false },
          ],
        },
        admin: { port: 0 },
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function adminFetch(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${adminBase}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

/** POST a `/v1/messages` request. A distinct `content` yields a distinct session
 *  key (the pool anchors affinity on system + first user message), so passing
 *  unique content exercises fresh priority/LRU selection; repeating one content
 *  exercises sticky affinity. */
function postMessages(content = 'ping'): Promise<Response> {
  return fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plaintextKey}` },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 16, messages: [{ role: 'user', content }] }),
  });
}

function accountBinding(options: {
  id: string;
  target: GatewayBinding['target'];
  apiKeyIds?: string[];
  priority?: number;
  fallback?: GatewayBinding['fallback'];
}): GatewayBinding {
  return {
    id: options.id,
    name: options.id,
    enabled: true,
    apiKeyIds: options.apiKeyIds,
    endpoint: 'messages',
    target: options.target,
    priority: options.priority,
    fallback: options.fallback ?? 'fail',
    modelMap: {
      fable: 'claude-sonnet-4-5',
      opus: 'claude-sonnet-4-5',
      sonnet: 'claude-sonnet-4-5',
      haiku: 'claude-sonnet-4-5',
    },
  };
}

async function setBindings(bindings: GatewayBinding[]): Promise<void> {
  const updated = await adminFetch('PUT', '/admin/api/server', { bindings });
  expect(updated.status).toBe(200);
  expect((await loadServerConfig(daemon.settingsStore)).bindings?.map((binding) => binding.id))
    .toEqual(bindings.map((binding) => binding.id));
  // The test intentionally boots on port 0. A config PUT may therefore rebind
  // to another ephemeral port; follow the live status before issuing traffic.
  baseUrl = daemon.outboundApiServer.getStatus().loopbackUrl as string;
}

beforeEach(async () => {
  resetDaemonSingletonsForTests();
  upstream = await startMockUpstream();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-multi-boot-'));

  const configPath = join(tmpDir, 'config.json');
  const keysPath = join(tmpDir, 'keys.json');
  const tokensPath = join(tmpDir, 'tokens.json');
  writeConfig(configPath);

  const config = loadConfig(configPath);
  daemon = buildDaemon(config, { configPath, keysPath, tokensPath, masterKeyFilePath: join(tmpDir, 'master.key') });

  // Seed TWO claude accounts (distinct bearers) — account A active initially.
  ({ id: accountAId } = await daemon.credentialStore.appendProviderAccount(
    'claude',
    { authMethod: 'oauth', status: 'authorized', accessToken: BEARER_A },
    'Account A',
  ));
  ({ id: accountBId } = await daemon.credentialStore.appendProviderAccount(
    'claude',
    { authMethod: 'oauth', status: 'authorized', accessToken: BEARER_B },
    'Account B',
  ));
  await daemon.credentialStore.patchAccountMetadata('claude', accountAId, { group: 'default' });
  await daemon.credentialStore.patchAccountMetadata('claude', accountBId, { group: 'team-a' });

  overrideUpstreamUrl(daemon, 'claude', `http://127.0.0.1:${upstream.port}/v1/messages`);

  await daemon.llmConfig.ready();
  await daemon.providerProxy.start();
  const serverConfig = await loadServerConfig(daemon.settingsStore);
  await daemon.outboundApiServer.applyConfig({
    enabled: true,
    networkBinding: serverConfig.networkBinding,
    endpoints: serverConfig.endpoints,
    bindings: serverConfig.bindings,
    port: serverConfig.port,
  });
  await daemon.adminServer.start();

  baseUrl = daemon.outboundApiServer.getStatus().loopbackUrl as string;
  adminBase = daemon.adminServer.getStatus().url as string;
  const created = await createNamedKey(daemon.keyDb, 'multi-boot');
  clientKeyId = created.id;
  plaintextKey = created.plaintextOnce;
});

afterEach(async () => {
  if (daemon) {
    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
  }
  await stopServer(upstream.server);
  resetDaemonSingletonsForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('omnicross daemon account pool → both accounts serve /v1/messages', () => {
  it('distinct conversations SPREAD across both account bearers', async () => {
    // Fire several requests, each with a DISTINCT first user message → distinct
    // session keys → fresh priority/LRU selection each time. Both bearers must be
    // observed (the non-active account emits traffic BY ID — the whole point).
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const res = await postMessages(`conversation-${i}`);
      expect(res.status).toBe(200);
      if (upstream.lastAuthHeader) seen.add(upstream.lastAuthHeader);
    }
    expect(seen).toEqual(new Set([`Bearer ${BEARER_A}`, `Bearer ${BEARER_B}`]));
  });

  it('one conversation (repeated body → one session key) STICKS to a single bearer', async () => {
    const first = await postMessages('sticky-conversation');
    expect(first.status).toBe(200);
    const pinned = upstream.lastAuthHeader;
    expect(pinned).toBeDefined();
    for (let i = 0; i < 4; i++) {
      const res = await postMessages('sticky-conversation');
      expect(res.status).toBe(200);
      expect(upstream.lastAuthHeader).toBe(pinned);
    }
  });

  it('switching the active account does NOT rotate the persistent active pointer via scheduling', async () => {
    // The admin active-switch still works (secret-free ack); the scheduler never
    // writes the active pointer, so it stays exactly where the admin API set it.
    const list = await daemon.credentialStore.listSanitizedAccounts();
    const accountA = list.claude.find((a) => a.label === 'Account A')!;
    const sw = await adminFetch('PUT', '/admin/api/accounts/claude/active', { id: accountA.id });
    expect(sw.status).toBe(200);
    expect(sw.text).not.toContain(BEARER_A);

    // Serve a spread of requests, then confirm the active pointer is untouched by
    // scheduling (still Account A — what the admin call set).
    for (let i = 0; i < 4; i++) await postMessages(`post-switch-${i}`);
    const after = await daemon.credentialStore.getFullConfig();
    expect(after.activeClaudeAccountId).toBe(accountA.id);
  });
});

describe('omnicross daemon gateway bindings → real /v1/messages routing', () => {
  it('a client-key-scoped binding outranks an unscoped binding', async () => {
    await setBindings([
      accountBinding({
        id: 'unscoped-a',
        target: { kind: 'account', providerId: 'claude', accountId: accountAId },
        priority: 1,
      }),
      accountBinding({
        id: 'scoped-b',
        target: { kind: 'account', providerId: 'claude', accountId: accountBId },
        apiKeyIds: [clientKeyId],
        priority: 999,
      }),
    ]);

    const response = await postMessages('client-key-binding');
    expect(response.status).toBe(200);
    expect(upstream.lastAuthHeader).toBe(`Bearer ${BEARER_B}`);
  });

  it('an account-group binding selects only a member of that group', async () => {
    await setBindings([
      accountBinding({
        id: 'team-a',
        target: { kind: 'account-group', providerId: 'claude', group: 'team-a' },
        apiKeyIds: [clientKeyId],
      }),
    ]);

    const response = await postMessages('account-group-binding');
    expect(response.status).toBe(200);
    expect(upstream.lastAuthHeader).toBe(`Bearer ${BEARER_B}`);
  });

  it('a missing strict account group fails without contacting the upstream', async () => {
    await setBindings([
      accountBinding({
        id: 'missing-team',
        target: { kind: 'account-group', providerId: 'claude', group: 'missing' },
        apiKeyIds: [clientKeyId],
      }),
    ]);
    const hitsBefore = upstream.hits;

    const response = await postMessages('missing-account-group');
    expect(response.status).toBe(503);
    expect(upstream.hits).toBe(hitsBefore);
  });

  it('a next-fallback route uses the provider pool when the bound account is unavailable', async () => {
    await daemon.credentialStore.patchAccountMetadata('claude', accountBId, { enabled: false });
    await setBindings([
      accountBinding({
        id: 'fallback-from-b',
        target: { kind: 'account', providerId: 'claude', accountId: accountBId },
        apiKeyIds: [clientKeyId],
        fallback: 'next',
      }),
    ]);

    const response = await postMessages('global-fallback');
    expect(response.status).toBe(200);
    expect(upstream.lastAuthHeader).toBe(`Bearer ${BEARER_A}`);
  });

  it('a next-fallback route leaves an unavailable account group and uses the full pool', async () => {
    await daemon.credentialStore.patchAccountMetadata('claude', accountBId, { enabled: false });
    await setBindings([
      accountBinding({
        id: 'fallback-from-team-a',
        target: { kind: 'account-group', providerId: 'claude', group: 'team-a' },
        apiKeyIds: [clientKeyId],
        fallback: 'next',
      }),
    ]);

    const response = await postMessages('account-group-global-fallback');
    expect(response.status).toBe(200);
    expect(upstream.lastAuthHeader).toBe(`Bearer ${BEARER_A}`);
  });
});
