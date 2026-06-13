/**
 * launch-boot-smoke.test.ts - THE e2e proof for `omnicross launch` (spec
 * `daemon-cli-launch`, tasks 3.2).
 *
 * A REAL child process (`node fake-cli.mjs`) plays the CLI: it receives the
 * builder env, calls the launch-process proxy over real HTTP with the route
 * token, and exits 0 only when the relayed upstream body comes back. The mock
 * upstream (real `node:http` server, boot-smoke idiom) records the auth header
 * so we can assert the proxy swapped the route token for the provider's REAL
 * key. After `runLaunch` returns: route table empty + proxy stopped.
 *
 * Also covers the secrets seams (spec "secrets compat"): an `enc:` provider key
 * round-trips (decrypted key reaches the upstream), and a pure-plaintext
 * config never materializes the master keyfile.
 *
 * NOT covered (honest): a real claude/codex/... binary - fake-cli proves OUR
 * side of the contract (env, route, relay, cleanup), not the CLIs' env
 * consumption habits.
 *
 * @module @omnicross/daemon/__tests__/launch-boot-smoke.test
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getProviderProxy } from '@omnicross/core/provider-proxy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetDaemonSingletonsForTests } from '../bootstrap';
import { type LaunchDeps, runLaunch } from '../commands/launch';
import { encryptValue, resolveMasterKey } from '../secrets';

const PROVIDER_REAL_KEY = 'sk-real-upstream-key-e2e';

const CANNED_COMPLETION = {
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  created: 1,
  model: 'mock-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

interface MockUpstream {
  server: Server;
  port: number;
  lastAuthHeader: string | undefined;
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

/**
 * The fake CLI: an OpenAI-style client (the qwen flavor). Reads
 * OPENAI_BASE_URL/_API_KEY/_MODEL, POSTs `<base>/chat/completions` with
 * `Authorization: Bearer <key>` (where the route token rides), exits 0 only on
 * a 200 whose relayed content is the canned 'pong'.
 */
const FAKE_CLI_SOURCE = `
const base = process.env.OPENAI_BASE_URL;
const key = process.env.OPENAI_API_KEY;
const res = await fetch(base + '/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
  body: JSON.stringify({
    model: process.env.OPENAI_MODEL,
    messages: [{ role: 'user', content: 'ping' }],
  }),
});
const body = await res.json().catch(() => null);
const ok = res.status === 200 && body?.choices?.[0]?.message?.content === 'pong';
process.exit(ok ? 0 : 1);
`;

let tmpDir: string;
let upstream: MockUpstream;
let configPath: string;
let masterKeyPath: string;
let fakeCliPath: string;

/** spawnCli dep that runs the REAL fake-CLI child with the plan's env. */
const spawnFakeCli: NonNullable<LaunchDeps['spawnCli']> = ({ env }) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fakeCliPath], {
      env: env as Record<string, string>,
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });

/** Hermetic deps: real fake-CLI spawn + host-PATH-independent plan building. */
const e2eDeps: LaunchDeps = { spawnCli: spawnFakeCli, resolveInPath: () => null };

function writeProviderConfig(apiKey: string): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      providers: [
        {
          id: 'mock',
          apiFormat: 'openai',
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey,
          models: ['mock-model'],
        },
      ],
    }),
  );
}

function launchArgv(): string[] {
  return [
    'qwen',
    '--provider',
    'mock',
    '--model',
    'mock-model',
    '--config',
    configPath,
    '--master-key-file',
    masterKeyPath,
  ];
}

beforeEach(async () => {
  resetDaemonSingletonsForTests();
  // Hermetic: the env master key would beat the per-test keyfile (D3 precedence).
  delete process.env['OMNICROSS_MASTER_KEY'];
  upstream = await startMockUpstream();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-launch-e2e-'));
  configPath = join(tmpDir, 'config.json');
  masterKeyPath = join(tmpDir, 'master.key');
  fakeCliPath = join(tmpDir, 'fake-cli.mjs');
  writeFileSync(fakeCliPath, FAKE_CLI_SOURCE);
});

afterEach(async () => {
  resetDaemonSingletonsForTests();
  await new Promise<void>((resolve) => {
    upstream.server.close(() => resolve());
  });
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('launch e2e - fake CLI through the in-process proxy', () => {
  it('round-trip: token in, REAL provider key out, 200 relayed, full cleanup', async () => {
    writeProviderConfig(PROVIDER_REAL_KEY);
    const code = await runLaunch(launchArgv(), e2eDeps);

    expect(code).toBe(0); // fake CLI verified the relayed 'pong'
    expect(upstream.hits).toBe(1);
    // The proxy swapped the route token for the provider's REAL key.
    expect(upstream.lastAuthHeader).toBe(`Bearer ${PROVIDER_REAL_KEY}`);
    // Cleanup: route removed; plaintext config never materialized a keyfile.
    expect(getProviderProxy().routeCount()).toBe(0);
    expect(existsSync(masterKeyPath)).toBe(false);
  });

  it('enc: provider key round-trips (secrets seam) - decrypted key reaches upstream', async () => {
    // Seal the provider key under the test master key, then launch with it.
    const key = resolveMasterKey({ keyFilePath: masterKeyPath });
    writeProviderConfig(encryptValue(PROVIDER_REAL_KEY, key));
    const code = await runLaunch(launchArgv(), e2eDeps);

    expect(code).toBe(0);
    expect(upstream.lastAuthHeader).toBe(`Bearer ${PROVIDER_REAL_KEY}`);
  });

  it('non-zero CLI exit code is relayed', async () => {
    writeProviderConfig(PROVIDER_REAL_KEY);
    writeFileSync(fakeCliPath, 'process.exit(42);');
    const code = await runLaunch(launchArgv(), e2eDeps);
    expect(code).toBe(42);
    expect(getProviderProxy().routeCount()).toBe(0);
  });
});
