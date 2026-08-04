/**
 * Full-daemon Claude multi-turn failover proof.
 *
 * The named-key protected `/v1/messages` listener, route resolver, subscription
 * account selector, health gate, and OAuth bearer injection all stay real. The
 * only replaced dependency is the Anthropic upstream, which is a loopback mock;
 * no paid credential or external request is used.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNamedKey, loadServerConfig } from '@omnicross/core/outbound-api';
import {
  getSharedAccountHealth,
  type AccountHealthDiagnostic,
} from '@omnicross/core/pipeline/SubscriptionAccountHealth';
import {
  setSubscriptionRegistryForOutbound,
  type SubscriptionRegistryLike,
} from '@omnicross/core/outbound-api/subscriptionRegistryPort';
import type { SubscriptionDispatchProfile } from '@omnicross/core/provider-proxy/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

const TOKEN_A = 'fake-claude-token-account-a';
const TOKEN_B = 'fake-claude-token-account-b';

interface UpstreamHit {
  authorization?: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
  status: number;
}

interface MockUpstream {
  server: Server;
  url: string;
  hits: UpstreamHit[];
}

const CANNED_RESPONSE = {
  id: 'msg-mock',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-5',
  content: [{ type: 'text', text: 'pong' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
};

function startMockUpstream(): Promise<MockUpstream> {
  const hits: UpstreamHit[] = [];
  const server = createServer((req, res) => {
    let rawBody = '';
    req.on('data', (chunk) => {
      rawBody += String(chunk);
    });
    req.on('end', () => {
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      const status = hits.length === 0 ? 429 : 200;
      hits.push({
        authorization: req.headers.authorization,
        headers: req.headers,
        body,
        status,
      });
      if (status === 429) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          // Claude's authoritative reset is epoch seconds, not a delta.
          'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 600),
        });
        res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'mock cooldown' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(CANNED_RESPONSE));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/v1/messages`, hits });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function writeConfig(configPath: string): void {
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        providers: [
          {
            id: 'mock-openai',
            apiFormat: 'openai',
            baseUrl: 'http://127.0.0.1:1/v1',
            apiKey: 'sk-unused-byo-key',
            models: ['mock-model'],
          },
        ],
        server: {
          enabled: true,
          networkBinding: false,
          port: 0,
          endpoints: [
            {
              endpoint: 'messages',
              modelMap: {
                fable: 'claude,claude-sonnet-4-5',
                opus: 'claude,claude-sonnet-4-5',
                sonnet: 'claude,claude-sonnet-4-5',
                haiku: 'claude,claude-sonnet-4-5',
              },
              useSubscription: true,
            },
            {
              endpoint: 'responses',
              modelMap: { codex: 'mock-openai,mock-model', mini: 'mock-openai,mock-model' },
              useSubscription: false,
            },
          ],
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

function overrideClaudeUpstreamUrl(daemon: Daemon, mockUrl: string): void {
  const real = daemon.subscriptionRegistry;
  const wrapper: SubscriptionRegistryLike = {
    getProfile(providerId: string): SubscriptionDispatchProfile | null {
      const profile = real.getProfile(providerId);
      if (!profile || providerId !== 'claude') return profile;
      return { ...profile, resolveUpstreamUrl: () => mockUrl };
    },
  };
  setSubscriptionRegistryForOutbound(wrapper);
}

describe('Claude: real daemon multi-turn health failover', () => {
  let tempRoot: string;
  let daemon: Daemon | undefined;
  let upstream: MockUpstream | undefined;
  let gatewayUrl: string;
  let namedKey: string;
  let accountAId: string;
  let accountBId: string;

  beforeEach(async () => {
    resetDaemonSingletonsForTests();
    tempRoot = mkdtempSync(join(tmpdir(), 'omnicross-claude-failover-'));
    upstream = await startMockUpstream();

    const configPath = join(tempRoot, 'config.json');
    writeConfig(configPath);
    daemon = buildDaemon(loadConfig(configPath), {
      configPath,
      keysPath: join(tempRoot, 'keys.json'),
      tokensPath: join(tempRoot, 'tokens.json'),
      masterKeyFilePath: join(tempRoot, 'master.key'),
    });

    ({ id: accountAId } = await daemon.credentialStore.appendProviderAccount(
      'claude',
      { authMethod: 'oauth', status: 'authorized', accessToken: TOKEN_A },
      'Claude A',
    ));
    ({ id: accountBId } = await daemon.credentialStore.appendProviderAccount(
      'claude',
      { authMethod: 'oauth', status: 'authorized', accessToken: TOKEN_B },
      'Claude B',
    ));
    overrideClaudeUpstreamUrl(daemon, upstream.url);

    await daemon.llmConfig.ready();
    await daemon.providerProxy.start();
    const serverConfig = await loadServerConfig(daemon.settingsStore);
    await daemon.outboundApiServer.applyConfig({
      enabled: true,
      networkBinding: serverConfig.networkBinding,
      endpoints: serverConfig.endpoints,
      port: serverConfig.port,
    });

    gatewayUrl = daemon.outboundApiServer.getStatus().loopbackUrl as string;
    namedKey = (await createNamedKey(daemon.keyDb, 'claude-failover-e2e')).plaintextOnce;
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.outboundApiServer.stop();
      await daemon.providerProxy.stop();
      daemon.apiKeyPool.dispose();
    }
    if (upstream) await stopServer(upstream.server);
    resetDaemonSingletonsForTests();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  async function postTurn(messages: Array<Record<string, unknown>>): Promise<Response> {
    return fetch(`${gatewayUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${namedKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 16,
        messages,
      }),
    });
  }

  it('moves a cooled account, keeps later turns sticky, and records the health edge', async () => {
    const firstTurn = [{ role: 'user', content: 'start one stable conversation' }];
    const first = await postTurn(firstTurn);
    expect(first.status).toBe(429);
    expect(upstream!.hits).toHaveLength(1);

    const firstBearer = upstream!.hits[0]!.authorization;
    expect([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`]).toContain(firstBearer);
    const cooledAccountId = firstBearer === `Bearer ${TOKEN_A}` ? accountAId : accountBId;
    const alternateBearer = firstBearer === `Bearer ${TOKEN_A}` ? `Bearer ${TOKEN_B}` : `Bearer ${TOKEN_A}`;

    const second = await postTurn([
      ...firstTurn,
      { role: 'assistant', content: 'mock first turn was rate limited' },
      { role: 'user', content: 'continue the same stable conversation' },
    ]);
    expect(second.status).toBe(200);
    expect(upstream!.hits[1]!.authorization).toBe(alternateBearer);

    const third = await postTurn([
      ...firstTurn,
      { role: 'assistant', content: 'pong' },
      { role: 'user', content: 'one more turn' },
    ]);
    expect(third.status).toBe(200);
    expect(upstream!.hits[2]!.authorization).toBe(alternateBearer);
    expect(upstream!.hits.map((hit) => hit.headers.authorization)).not.toContain(
      `Bearer ${namedKey}`,
    );

    const diagnostics = getSharedAccountHealth().getDiagnostics({
      providerId: 'claude',
      accountId: cooledAccountId,
    });
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'health-anomaly',
          providerId: 'claude',
          accountId: cooledAccountId,
          state: 'rate_limited',
        }),
      ] satisfies Array<Partial<AccountHealthDiagnostic>>),
    );
    expect(getSharedAccountHealth().getStatus('claude', cooledAccountId).state).toBe('rate_limited');
  });
});
