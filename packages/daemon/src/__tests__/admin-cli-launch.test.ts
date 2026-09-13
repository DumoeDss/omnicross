/**
 * admin-cli-launch.test.ts — the dashboard "launch a coding CLI" admin routes.
 *
 *  - GET /admin/api/cli                 → per-CLI availability (PATH probe).
 *  - POST /admin/api/cli/:cli/launch    → register the resident route + open a
 *                                         terminal with the redirect env.
 *                                         With `{ keyId }` (codex): key-scoped
 *                                         launch through the gateway bindings.
 *  - GET /admin/api/cli/sessions        → list running launches.
 *  - DELETE /admin/api/cli/sessions/:id → stop (remove the route).
 *
 * The PATH probe + terminal opener are injected (test seams) so the test never
 * spawns a real window. SECRET SPINE asserted: the route token rides ONLY the
 * spawned terminal's env — it NEVER appears in any response body; for key-scoped
 * launches NO secret appears anywhere at all (the auth helper fetches it).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createNamedKey,
  type GatewayBinding,
  loadServerConfig,
  type OutboundPermission,
  saveServerConfig,
} from '@omnicross/core/outbound-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildKeyScopedCodexArgs,
  type CommandRunner,
  resetCliSessions,
  type TerminalOpener,
} from '../admin/cliLaunch';
import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

interface OpenerCall {
  cli: string;
  command: string;
  extraArgs: string[];
  env: Record<string, string>;
  cwd?: string;
}
let openerCalls: OpenerCall[] = [];
const spyOpener: TerminalOpener = (input) => {
  openerCalls.push({
    cli: input.cli,
    command: input.command,
    extraArgs: input.extraArgs,
    env: input.env,
    cwd: input.cwd,
  });
};

/** Fake PATH: claude + codex are "installed", everything else is not. */
const fakeProbe = (candidate: string): string | null =>
  candidate.includes('claude') || candidate.includes('codex')
    ? `/fake/bin/${candidate}`
    : null;

let runnerCalls: string[] = [];
let runnerOk = true;
const spyRunner: CommandRunner = (command) => {
  runnerCalls.push(command);
  return Promise.resolve(runnerOk ? { ok: true } : { ok: false, error: 'boom: npm ENOENT' });
};

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
let daemon: Daemon;

function writeConfig(configPath: string): void {
  const cfg = {
    providers: [
      { id: 'mock', apiFormat: 'anthropic', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-mock-zzz', models: ['mock-model'] },
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
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

beforeEach(async () => {
  openerCalls = [];
  runnerCalls = [];
  runnerOk = true;
  resetDaemonSingletonsForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-cli-'));
  const configPath = join(tmpDir, 'config.json');
  writeConfig(configPath);
  daemon = buildDaemon(loadConfig(configPath), {
    configPath,
    keysPath: join(tmpDir, 'keys.json'),
    tokensPath: join(tmpDir, 'tokens.json'),
    masterKeyFilePath: join(tmpDir, 'master.key'),
    cliTerminalOpener: spyOpener,
    cliPathProbe: fakeProbe,
    cliCommandRunner: spyRunner,
  });
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
  adminBase = daemon.adminServer.getStatus().url as string;
});

afterEach(async () => {
  resetCliSessions();
  if (daemon) {
    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
  }
  resetDaemonSingletonsForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('Code CLI launch', () => {
  it('GET /cli lists each CLI with its PATH-probed availability + installable flag', async () => {
    const r = await adminFetch('GET', '/admin/api/cli');
    expect(r.status).toBe(200);
    const clis = (r.json as { clis: Array<{ id: string; installed: boolean; installable: boolean }> }).clis;
    expect(clis.find((c) => c.id === 'claude')?.installed).toBe(true);
    expect(clis.find((c) => c.id === 'codex')?.installed).toBe(true);
    // Every launchable CLI currently ships a global install command.
    expect(clis.every((c) => c.installable)).toBe(true);
  });

  it('installs a CLI: runs its install command on the host, returns ok', async () => {
    const r = await adminFetch('POST', '/admin/api/cli/codex/install');
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
    expect(runnerCalls).toEqual(['npm install -g @openai/codex']);
  });

  it('reports an install failure as 500 with the reason', async () => {
    runnerOk = false;
    const r = await adminFetch('POST', '/admin/api/cli/gemini/install');
    expect(r.status).toBe(500);
    expect(r.text).toMatch(/boom: npm ENOENT/);
    expect(runnerCalls).toEqual(['npm install -g @google/gemini-cli']);
  });

  it('rejects installing an unknown cli id (400)', async () => {
    const r = await adminFetch('POST', '/admin/api/cli/notacli/install');
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/unknown cli/i);
    expect(runnerCalls).toHaveLength(0);
  });

  it('launches claude: opens a terminal with the redirect env; token never in the response', async () => {
    const r = await adminFetch('POST', '/admin/api/cli/claude/launch', { cwd: '/tmp/work' });
    expect(r.status).toBe(200);
    const out = r.json as { sessionId: string; providerId: string; model: string };
    expect(out.providerId).toBe('mock');
    expect(out.model).toBe('mock-model');

    // The opener received the redirect env (base URL + a route token).
    expect(openerCalls).toHaveLength(1);
    const call = openerCalls[0];
    expect(call.cli).toBe('claude');
    expect(call.cwd).toBe('/tmp/work');
    expect(call.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const token = call.env.ANTHROPIC_AUTH_TOKEN;
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(8);

    // STATUS-ONLY: the route token NEVER appears in the response body.
    expect(r.text).not.toContain(token);

    // The session is tracked, then stoppable.
    const list = await adminFetch('GET', '/admin/api/cli/sessions');
    const sessions = (list.json as { sessions: Array<{ id: string; cli: string }> }).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cli).toBe('claude');
    expect(list.text).not.toContain(token); // sessions list is token-free too

    const stop = await adminFetch('DELETE', `/admin/api/cli/sessions/${out.sessionId}`);
    expect(stop.status).toBe(200);
    const after = await adminFetch('GET', '/admin/api/cli/sessions');
    expect((after.json as { sessions: unknown[] }).sessions).toHaveLength(0);
  });

  it('rejects launching a CLI that is not installed (400)', async () => {
    const r = await adminFetch('POST', '/admin/api/cli/gemini/launch', {});
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/not installed/i);
    expect(openerCalls).toHaveLength(0);
  });

  it('rejects an unknown cli id (400)', async () => {
    const r = await adminFetch('POST', '/admin/api/cli/notacli/launch', {});
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/unknown cli/i);
  });
});

describe('Key-scoped codex launch', () => {
  /** Create a gateway key with codex permissions; optionally bind it to a responses route. */
  async function makeRoutedKey(options?: { permissions?: string[]; bind?: boolean }): Promise<{ id: string; name: string; plaintext: string }> {
    const created = await createNamedKey(daemon.keyDb, 'route-key');
    const permissions = (options?.permissions ?? ['responses', 'images']) as OutboundPermission[];
    await daemon.keyDb.outboundApiKeysSetPermissions(created.id, permissions);
    if (options?.bind !== false) {
      const current = await loadServerConfig(daemon.settingsStore);
      const binding: GatewayBinding = {
        id: 'test-responses-route',
        name: 'Test responses route',
        enabled: true,
        keyScope: 'selected',
        apiKeyIds: [created.id],
        endpoint: 'responses',
        target: { kind: 'provider', providerId: 'mock' },
        priority: 100,
        fallback: 'fail',
        modelMode: 'passthrough',
      };
      const next = { ...current, bindings: [binding] };
      await saveServerConfig(daemon.settingsStore, next);
      await daemon.outboundApiServer.applyConfig({
        enabled: true,
        networkBinding: current.networkBinding,
        endpoints: current.endpoints,
        bindings: next.bindings,
        port: current.port,
      });
    }
    return { id: created.id, name: created.name, plaintext: created.plaintextOnce };
  }

  it('launches codex scoped to a gateway key: auth-command overrides, no secret anywhere', async () => {
    const key = await makeRoutedKey();
    const r = await adminFetch('POST', '/admin/api/cli/codex/launch', { keyId: key.id, cwd: '/tmp/proj' });
    expect(r.status).toBe(200);
    const out = r.json as { sessionId: string; keyId: string; keyName: string };
    expect(out.keyId).toBe(key.id);
    expect(out.keyName).toBe(key.name);

    // The opener received the -c overrides redirecting codex at the gateway.
    expect(openerCalls).toHaveLength(1);
    const call = openerCalls[0];
    expect(call.cli).toBe('codex');
    expect(call.cwd).toBe('/tmp/proj');
    const args = call.extraArgs;
    expect(args).toContain('model_provider="omnicross"');
    // The installed provider NAME is reused (codex sessions bind to it).
    expect(args.some((a) => a.startsWith('model_providers.omnicross.base_url='))).toBe(true);
    expect(args.some((a) => a.includes('/v1"'))).toBe(true);
    const authArgs = args.find((a) => a.startsWith('model_providers.omnicross.auth.args='));
    expect(authArgs).toBeDefined();
    // The helper invocation carries the chosen key id…
    expect(authArgs).toContain('--key-id');
    expect(authArgs).toContain(key.id);
    // …and NO key plaintext rides the env (or any string) — the helper fetches it.
    expect(JSON.stringify(call)).not.toContain(key.plaintext);

    // STATUS-ONLY + secret-free response body.
    expect(r.text).not.toContain(key.plaintext);
    expect(r.text).not.toContain('sk-omnicross-');

    // The session row is key-labelled and stoppable.
    const list = await adminFetch('GET', '/admin/api/cli/sessions');
    const sessions = (list.json as { sessions: Array<{ id: string; keyName?: string; providerId: string }> }).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].keyName).toBe(key.name);
    expect(sessions[0].providerId).toBe('');
    const stop = await adminFetch('DELETE', `/admin/api/cli/sessions/${out.sessionId}`);
    expect(stop.status).toBe(200);
  });

  it('rejects a key-scoped launch for a non-codex CLI (400)', async () => {
    const key = await makeRoutedKey();
    const r = await adminFetch('POST', '/admin/api/cli/claude/launch', { keyId: key.id });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/only supported for codex/i);
    expect(openerCalls).toHaveLength(0);
  });

  it('rejects an unknown key id (404)', async () => {
    await makeRoutedKey();
    const r = await adminFetch('POST', '/admin/api/cli/codex/launch', { keyId: 'oak_missing' });
    expect(r.status).toBe(404);
    expect(r.text).toMatch(/does not exist/i);
    expect(openerCalls).toHaveLength(0);
  });

  it('rejects a key without codex endpoint permissions (400)', async () => {
    const key = await makeRoutedKey({ permissions: ['responses'], bind: false });
    const r = await adminFetch('POST', '/admin/api/cli/codex/launch', { keyId: key.id });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/lacks the 'images' endpoint permission/i);
    expect(openerCalls).toHaveLength(0);
  });

  it('rejects a key with no enabled responses binding (400)', async () => {
    // Route the responses endpoint to ANOTHER key first — key-scoped candidates
    // suppress the all-scoped legacy projection, so this key owns no route.
    await makeRoutedKey();
    const key = await makeRoutedKey({ bind: false });
    const r = await adminFetch('POST', '/admin/api/cli/codex/launch', { keyId: key.id });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/no enabled responses route/i);
    expect(openerCalls).toHaveLength(0);
  });
});

describe('buildKeyScopedCodexArgs', () => {
  it('renders the install-shaped provider block under the shared provider name', () => {
    const args = buildKeyScopedCodexArgs({
      gatewayBaseUrl: 'http://127.0.0.1:8765/',
      authHelper: { command: 'C:/node/node.exe', args: ['cli.js', 'integrations', 'token', 'codex', '--config', 'cfg.json'] },
      keyId: 'oak_1',
    });
    expect(args).toEqual([
      '-c', 'model_provider="omnicross"',
      '-c', 'model_providers.omnicross.name="OmniCross Local Gateway"',
      '-c', 'model_providers.omnicross.base_url="http://127.0.0.1:8765/v1"',
      '-c', 'model_providers.omnicross.wire_api="responses"',
      '-c', 'model_providers.omnicross.supports_websockets=false',
      '-c', 'model_providers.omnicross.http_headers={"X-OpenAI-Actor-Authorization"="omnicross"}',
      '-c', 'model_providers.omnicross.auth.command="C:/node/node.exe"',
      '-c', 'model_providers.omnicross.auth.args=["cli.js","integrations","token","codex","--config","cfg.json","--key-id","oak_1"]',
      '-c', 'model_providers.omnicross.auth.refresh_interval_ms=0',
      '-c', 'model_providers.omnicross.auth.timeout_ms=5000',
      '-c', 'disable_response_storage=true',
    ]);
  });
});

