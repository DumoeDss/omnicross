/**
 * pool-failover-boot-smoke.test.ts — daemon e2e proof that ApiKeyPool failover
 * actually FIRES on the outbound serving path (omnicross-daemon-parity-poolseam,
 * design D4 + spec "daemon 对外失效转移端到端证明").
 *
 * Mirrors `boot-smoke.test.ts` + `admin-pool-health.test.ts` IN-PROCESS wiring:
 *   mock node:http upstream that returns 429 for the FIRST pool key and 200 for
 *   the SECOND (keyed on the auth header it sees)
 *   → temp config.json: 1 OpenAI provider with a 2-key pool (`k1`, `k2` literals)
 *   → buildDaemon → providerProxy.start() → applyConfig(enabled) → createNamedKey
 *
 * Asserts (spec scenarios):
 *   - AUTHED /v1/chat/completions → 200 (rotated to the second key after the 429)
 *   - the upstream's SECOND call carried the SECOND key (k2)
 *   - `daemon.apiKeyPool.getKeyHealth('mock')` shows the first key cooling
 *     (`lastStatus: 429`, `until > now`)
 *   - a SECOND request for the same named key affinity-binds to the already-
 *     rebound k2 (stable synthesized id → bounded binding) and hits upstream once
 *
 * daemon production code is UNCHANGED — the pool already occupies
 * `ProviderProxyDeps.apiKeyPool`; the core poolseam makes it hot. This test file
 * is the ONLY daemon-side addition.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNamedKey, loadServerConfig } from '@omnicross/core/outbound-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

const CANNED_OK = {
  id: 'chatcmpl-failover-ok',
  object: 'chat.completion',
  created: 1,
  model: 'mock-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

// The 2 pool keys (literals so the upstream can discriminate which one arrived).
const KEY_1 = 'sk-failover-key-1-AAAA';
const KEY_2 = 'sk-failover-key-2-BBBB';

interface MockUpstream {
  server: Server;
  port: number;
  /** The auth-header value (sans `Bearer `) for each upstream hit, in order. */
  keysSeen: string[];
}

/**
 * Mock upstream: returns 429 to the FIRST pool key (`KEY_1`) and 200 to any
 * other key. Records the resolved key each hit carried so the test can assert
 * the rotation reached the wire.
 */
function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = { server: undefined as unknown as Server, port: 0, keysSeen: [] };
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const auth = (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '').trim();
      state.keysSeen.push(auth);
      if (auth === KEY_1) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'rate_limit', code: 429 } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(CANNED_OK));
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

function writeConfig(path: string, providerBase: string): void {
  const cfg = {
    providers: [
      {
        id: 'mock',
        apiFormat: 'openai',
        baseUrl: providerBase,
        // No single apiKey — a 2-key pool. The first enabled key (k1) is selected
        // first by the weighted round-robin (idx 0, weight 1 each → k1).
        apiKey: '',
        apiKeys: [
          { id: 'k1', apiKey: KEY_1, label: 'first', weight: 1 },
          { id: 'k2', apiKey: KEY_2, label: 'second', weight: 1 },
        ],
        models: ['mock-model'],
      },
    ],
    server: {
      enabled: true,
      networkBinding: false,
      port: 0,
      endpoints: [
        { endpoint: 'chat', defaultModel: 'mock,mock-model', backgroundModel: 'mock,mock-model', useSubscription: false },
      ],
    },
  };
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
}

beforeEach(async () => {
  resetDaemonSingletonsForTests();
  upstream = await startMockUpstream();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-failover-'));
  const configPath = join(tmpDir, 'config.json');
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
  baseUrl = daemon.outboundApiServer.getStatus().loopbackUrl as string;
});

afterEach(async () => {
  if (daemon) {
    await daemon.outboundApiServer.stop();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
  }
  if (upstream) await stopServer(upstream.server);
  resetDaemonSingletonsForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('omnicross daemon outbound pool failover (e2e, daemon prod code unchanged)', () => {
  it('429 on the first key → rotates to the second key → 200; upstream 2nd call carries key2; key1 cooling', async () => {
    const created = await createNamedKey(daemon.keyDb, 'failover-smoke');
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.plaintextOnce}` },
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'ping' }] }),
    });

    // The 429 was discarded; the rotated retry's 200 was relayed.
    expect(res.status).toBe(200);
    const json = (await res.json()) as typeof CANNED_OK;
    expect(json.choices[0].message.content).toBe('pong');

    // Two upstream calls: the 429 (key1) then the 200 (key2).
    expect(upstream.keysSeen.length).toBe(2);
    expect(upstream.keysSeen[0]).toBe(KEY_1);
    expect(upstream.keysSeen[1]).toBe(KEY_2);

    // The pool cooled the first key after the 429.
    const health = await daemon.apiKeyPool.getKeyHealth('mock');
    expect(health['k1']).toBeDefined();
    expect(health['k1'].lastStatus).toBe(429);
    expect(health['k1'].until).toBeGreaterThan(Date.now());
    // The rebound key is NOT cooling.
    expect(health['k2']).toBeUndefined();
  });

  it('a second request for the same named key affinity-binds to the rebound key2 (stable id → bounded)', async () => {
    const created = await createNamedKey(daemon.keyDb, 'failover-affinity');

    const first = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.plaintextOnce}` },
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'ping' }] }),
    });
    expect(first.status).toBe(200);
    // First request: 429(k1) → retry 200(k2) = 2 upstream calls.
    expect(upstream.keysSeen.length).toBe(2);

    const second = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.plaintextOnce}` },
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'again' }] }),
    });
    expect(second.status).toBe(200);
    // Affinity: the session is already bound to k2 (k1 still cooling), so the
    // second request goes straight to k2 with NO extra rotation — exactly one
    // more upstream call carrying k2.
    expect(upstream.keysSeen.length).toBe(3);
    expect(upstream.keysSeen[2]).toBe(KEY_2);

    // Bounded memory: the stable synthesized id means exactly ONE binding for
    // this named key, not one per request.
    const bindings = (daemon.apiKeyPool as unknown as { sessionBindings: Map<string, unknown> })
      .sessionBindings;
    expect(bindings.size).toBe(1);
  });
});
