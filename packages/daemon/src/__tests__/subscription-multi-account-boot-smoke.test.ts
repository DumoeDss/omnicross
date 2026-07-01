/**
 * subscription-multi-account-boot-smoke.test.ts — the active-account-switch
 * proof for `subscription-multi-account` (task 11.4).
 *
 * Two claude accounts in tokens.json (each with a distinct OAuth bearer) →
 * switch the active account via `PUT /admin/api/accounts/claude/active` → the
 * NEXT subscription `/v1/messages` request carries the OTHER account's bearer.
 * REAL core routing + REAL PassThroughAuthStrategy; ONLY the upstream is mocked.
 *
 * Sibling of `subscription-messages-boot-smoke.test.ts` (kept separate, not an
 * edit of it).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNamedKey, loadServerConfig } from '@omnicross/core/outbound-api';
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

function postMessages(): Promise<Response> {
  return fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plaintextKey}` },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
  });
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
  await daemon.credentialStore.appendProviderAccount(
    'claude',
    { authMethod: 'oauth', status: 'authorized', accessToken: BEARER_A },
    'Account A',
  );
  await daemon.credentialStore.appendProviderAccount(
    'claude',
    { authMethod: 'oauth', status: 'authorized', accessToken: BEARER_B },
    'Account B',
  );

  overrideUpstreamUrl(daemon, 'claude', `http://127.0.0.1:${upstream.port}/v1/messages`);

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

  baseUrl = daemon.outboundApiServer.getStatus().loopbackUrl as string;
  adminBase = daemon.adminServer.getStatus().url as string;
  const created = await createNamedKey(daemon.keyDb, 'multi-boot');
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

describe('omnicross daemon multi-account active-switch → outbound bearer follows', () => {
  it('switching the active claude account changes the /v1/messages bearer', async () => {
    // Account B is active (appended last) → first request carries B's bearer.
    let res = await postMessages();
    expect(res.status).toBe(200);
    expect(upstream.lastAuthHeader).toBe(`Bearer ${BEARER_B}`);

    // Switch active to Account A via the admin API.
    const list = await daemon.credentialStore.listSanitizedAccounts();
    const accountA = list.claude.find((a) => a.label === 'Account A')!;
    const sw = await adminFetch('PUT', '/admin/api/accounts/claude/active', { id: accountA.id });
    expect(sw.status).toBe(200);
    expect(sw.text).not.toContain(BEARER_A);

    // The NEXT request carries Account A's bearer (real store→strategy→bearer).
    res = await postMessages();
    expect(res.status).toBe(200);
    expect(upstream.lastAuthHeader).toBe(`Bearer ${BEARER_A}`);
  });
});
