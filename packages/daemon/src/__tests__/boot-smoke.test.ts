/**
 * boot-smoke.test.ts — THE CENTERPIECE (design D8).
 *
 * Proves the standalone wiring end-to-end IN PROCESS (there is no live-spawn
 * harness, so this IS the verification):
 *
 *   mock node:http upstream (canned OpenAI completion + records its auth header)
 *   → temp config.json with 1 fake OpenAI provider pointing at the mock
 *   → buildDaemon → providerProxy.start() → applyConfig(enabled:true)
 *   → createNamedKey (capture the one-time plaintext)
 *
 * Asserts: getStatus running + port>0; an AUTHED /v1/chat/completions → 200 with
 * the mock's body AND the mock saw the provider's REAL apiKey (transformer +
 * auth + routing flowed through core); UNAUTHED → 401; /v1/messages BYO → 200
 * (the built-in factory-less Anthropic BYO path, `omnicross-anthropic-byo-ingress`
 * — no factory, no longer 502). This single test shows the file-backed ports
 * satisfy core's interfaces and the extraction is host-agnostic.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNamedKey, loadServerConfig } from '@omnicross/core/outbound-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDaemon, type Daemon,resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

// ── Mock upstream provider ────────────────────────────────────────────────────

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

const PROVIDER_REAL_KEY = 'sk-provider-real-key-12345';

interface MockUpstream {
  server: Server;
  port: number;
  /** The `authorization` header value the upstream last received. */
  lastAuthHeader: string | undefined;
  /** Whether the upstream was hit. */
  hits: number;
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = {
    server: undefined as unknown as Server,
    port: 0,
    lastAuthHeader: undefined,
    hits: 0,
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.hits += 1;
      state.lastAuthHeader = req.headers['authorization'];
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

// ── Fixture wiring ────────────────────────────────────────────────────────────

let tmpDir: string;
let upstream: MockUpstream;
let daemon: Daemon;
let baseUrl: string;
let plaintextKey: string;

beforeEach(async () => {
  resetDaemonSingletonsForTests();
  upstream = await startMockUpstream();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-daemon-'));

  const configPath = join(tmpDir, 'config.json');
  const keysPath = join(tmpDir, 'keys.json');
  // tokens.json is intentionally absent here — the BYO smoke never routes a
  // subscription request; the credential store tolerates the missing file.
  const tokensPath = join(tmpDir, 'tokens.json');

  // One fake OpenAI provider whose baseUrl points at the mock upstream. The
  // OpenAI URL builder appends `/chat/completions` to the `/v1` base.
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
          // Ephemeral port so parallel tests never collide.
          port: 0,
          endpoints: [
            {
              endpoint: 'chat',
              defaultModel: 'mock,mock-model',
              backgroundModel: 'mock,mock-model',
              useSubscription: false,
            },
            {
              // Configured with a valid BYO model ref so the route RESOLVES and
              // reaches the Anthropic ingress — where the ABSENT
              // anthropicIngressHandlerFactory now triggers the built-in
              // factory-less BYO path (omnicross-anthropic-byo-ingress), which
              // serves the request (200) instead of the old deferred 502.
              endpoint: 'messages',
              modelMap: {
                fable: 'mock,mock-model',
                opus: 'mock,mock-model',
                sonnet: 'mock,mock-model',
                haiku: 'mock,mock-model',
              },
              useSubscription: false,
            },
            {
              // responses needs a complete kind map too (strict startup gate).
              endpoint: 'responses',
              modelMap: { codex: 'mock,mock-model', mini: 'mock,mock-model' },
              useSubscription: false,
            },
          ],
        },
      },
      null,
      2,
    ),
    'utf8',
  );

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

  const status = daemon.outboundApiServer.getStatus();
  baseUrl = status.loopbackUrl as string;

  const created = await createNamedKey(daemon.keyDb, 'smoke');
  plaintextKey = created.plaintextOnce;
});

afterEach(async () => {
  await daemon.outboundApiServer.stop();
  await daemon.providerProxy.stop();
  daemon.apiKeyPool.dispose(); // stop the pool's cooldown-cleanup interval
  await stopServer(upstream.server);
  resetDaemonSingletonsForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Assertions ──────────────────────────────────────────────────────────────

describe('omnicross daemon boot smoke (standalone proof)', () => {
  it('binds the outbound server on an ephemeral port', () => {
    const status = daemon.outboundApiServer.getStatus();
    expect(status.running).toBe(true);
    expect(status.port).toBeGreaterThan(0);
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('routes an AUTHED chat request through core to the mock upstream', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${plaintextKey}`,
      },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as typeof CANNED_COMPLETION;
    expect(json.id).toBe(CANNED_COMPLETION.id);
    expect(json.choices[0].message.content).toBe('pong');

    // The mock upstream must have received the PROVIDER's real key — proving the
    // transformer + auth + routing flowed through core (the external named key
    // never reached upstream; the BYO provider key did).
    expect(upstream.hits).toBe(1);
    expect(upstream.lastAuthHeader).toBe(`Bearer ${PROVIDER_REAL_KEY}`);
  });

  it('rejects an UNAUTHED request with 401', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', messages: [] }),
    });
    expect(res.status).toBe(401);
    expect(upstream.hits).toBe(0);
  });

  it('serves the built-in BYO Anthropic /v1/messages ingress with 200 (no longer 502)', async () => {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${plaintextKey}`,
      },
      body: JSON.stringify({
        model: 'mock,mock-model',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 16,
      }),
    });
    // The built-in factory-less BYO path routes through the OpenAI-format mock
    // upstream and re-encodes the response back to the Anthropic wire — 200, not
    // the old deferred 502.
    expect(res.status).toBe(200);
    // The mock upstream (OpenAI-format) was hit with the provider's REAL key.
    expect(upstream.hits).toBe(1);
    expect(upstream.lastAuthHeader).toBe(`Bearer ${PROVIDER_REAL_KEY}`);
    // Response is Anthropic-shaped (`type: 'message'` with content blocks).
    const json = (await res.json()) as { type?: string; content?: unknown };
    expect(json.type).toBe('message');
  });
});

// ── Usage/pricing serving-path wiring (usage-pricing child) ──────────────────

describe('usage recorder serving-path wiring', () => {
  it('boots with no pricing.json / usage-events.jsonl present (lazy creation)', () => {
    expect(existsSync(join(tmpDir, 'pricing.json'))).toBe(false);
    expect(existsSync(join(tmpDir, 'usage-events.jsonl'))).toBe(false);
    // The wired handles exist and the proxy deps slot carries the recorder.
    expect(daemon.usageRecorder).toBeDefined();
    expect(daemon.providerProxy.getDeps().usageRecorder).toBe(daemon.usageRecorder);
  });

  it('a served chat request persists a COSTED usage-events.jsonl row', async () => {
    // Price the mock model so the engine cost-stamps the event.
    await daemon.pricingEngine.upsertManual({
      providerId: 'mock',
      modelId: 'mock-model',
      inputPricePer1m: 1_000_000, // $1 per token → easy to assert
      outputPricePer1m: 1_000_000,
    });

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plaintextKey}` },
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'ping' }] }),
    });
    expect(res.status).toBe(200);

    // Recording is fire-and-forget (deferred) — poll briefly for the append.
    const eventsPath = join(tmpDir, 'usage-events.jsonl');
    let lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      if (existsSync(eventsPath)) {
        lines = readFileSync(eventsPath, 'utf8').split('\n').filter((l) => l.trim());
        if (lines.length > 0) break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]) as {
      providerId: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    };
    expect(row.model).toBe('mock-model');
    // CANNED usage: 1 prompt + 1 completion token at $1/token each.
    expect(row.inputTokens).toBe(1);
    expect(row.outputTokens).toBe(1);
    expect(row.costUsd).toBeCloseTo(2);
  });

  it('a usage-event append failure only warns (serving unaffected)', async () => {
    // Make the append fail: occupy the events path with a DIRECTORY.
    mkdirSync(join(tmpDir, 'usage-events.jsonl'));
    const warnSpy = vi.spyOn(daemon.logger, 'warn');

    // Awaitable variant so the test can assert after the (failed) insert.
    const id = await daemon.usageRecorder.recordAsync({
      providerId: 'mock',
      model: 'mock-model',
      engineOrigin: 'completion',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 },
    });
    expect(id).toBeNull(); // failure swallowed, never thrown
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes('store insert failed')),
    ).toBe(true);
    warnSpy.mockRestore();

    // Serving still works after the failed append.
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plaintextKey}` },
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'ping' }] }),
    });
    expect(res.status).toBe(200);
  });
});
