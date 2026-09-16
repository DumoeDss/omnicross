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
  createIntegrationKey,
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
  detectClis,
  parseCliVersion,
  resetCliSessions,
  type TerminalOpener,
  type VersionRunner,
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

/** Fake PATH: claude + codex + qwen are "installed", everything else is not. */
const fakeProbe = (candidate: string): string | null =>
  candidate.includes('claude') || candidate.includes('codex') || candidate.includes('qwen')
    ? `/fake/bin/${candidate}`
    : null;

let runnerCalls: string[] = [];
let runnerOk = true;
const spyRunner: CommandRunner = (command) => {
  runnerCalls.push(command);
  return Promise.resolve(runnerOk ? { ok: true } : { ok: false, error: 'boom: npm ENOENT' });
};

/** Version-probe stub: `--version` outputs are keyed by CLI command prefix. */
let versionCalls: string[] = [];
let versionOutputs: Record<string, string> = {};
let versionOk = true;
const spyVersionRunner: VersionRunner = (command) => {
  versionCalls.push(command);
  const hit = Object.keys(versionOutputs).find((key) => command.startsWith(key));
  const output = hit ? versionOutputs[hit] : undefined;
  return Promise.resolve(
    versionOk && output !== undefined ? { ok: true, output } : { ok: false, error: 'version probe failed' },
  );
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
  versionCalls = [];
  versionOutputs = {};
  versionOk = true;
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
    cliVersionRunner: spyVersionRunner,
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
    const clis = (r.json as { clis: Array<{ id: string; installed: boolean; installable: boolean; launchable: boolean }> }).clis;
    expect(clis.find((c) => c.id === 'claude')?.installed).toBe(true);
    expect(clis.find((c) => c.id === 'codex')?.installed).toBe(true);
    // Every tracked CLI currently ships a global install command.
    expect(clis.every((c) => c.installable)).toBe(true);
    // The install-only additions are listed but not launchable.
    expect(clis.find((c) => c.id === 'grok')?.launchable).toBe(false);
    expect(clis.find((c) => c.id === 'openclaw')?.launchable).toBe(false);
    expect(clis.find((c) => c.id === 'hermes')?.launchable).toBe(false);
    expect(clis.find((c) => c.id === 'pi')?.launchable).toBe(false);
    expect(clis.find((c) => c.id === 'claude')?.launchable).toBe(true);
  });

  it('hides the Hermes install button off Windows (its installer is PowerShell-only)', () => {
    const linux = detectClis('linux', fakeProbe);
    expect(linux.find((c) => c.id === 'hermes')?.installable).toBe(false);
    const win = detectClis('win32', fakeProbe);
    expect(win.find((c) => c.id === 'hermes')?.installable).toBe(true);
  });

  it('GET /cli/versions probes installed CLIs: --version output + npm registry latest', async () => {
    versionOutputs = {
      'claude --version': '2.1.32 (Claude Code)\n',
      'codex --version': 'codex-cli 0.55.0\n',
      'npm view @anthropic-ai/claude-code version': '2.2.0\n',
      'npm view @openai/codex version': '"0.55.0"\n',
    };
    const r = await adminFetch('GET', '/admin/api/cli/versions');
    expect(r.status).toBe(200);
    const versions = (r.json as { versions: Record<string, { installed?: string; latest?: string }> }).versions;
    // Only PATH-installed CLIs (fakeProbe: claude/codex/qwen) are probed.
    expect(Object.keys(versions).sort()).toEqual(['claude', 'codex', 'qwen']);
    expect(versions['claude']).toEqual({ installed: '2.1.32', latest: '2.2.0' });
    expect(versions['codex']).toEqual({ installed: '0.55.0', latest: '0.55.0' });
    // A failed probe leaves the field out instead of failing the whole call.
    expect(versions['qwen']).toEqual({});
  });

  it('parseCliVersion takes the first semver on the first line, tolerating v-prefixed multiline output', () => {
    expect(parseCliVersion('2.1.32 (Claude Code)\n')).toBe('2.1.32');
    expect(parseCliVersion('codex-cli 0.55.0\n')).toBe('0.55.0');
    expect(parseCliVersion('v0.19.5\n')).toBe('0.19.5');
    expect(parseCliVersion('opencode\nVersion: 0.19.5\n')).toBe('0.19.5');
    expect(parseCliVersion('')).toBeNull();
    expect(parseCliVersion('no digits here')).toBeNull();
  });

  it('installs a CLI: runs its install command on the host, returns ok', async () => {
    const r = await adminFetch('POST', '/admin/api/cli/codex/install');
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
    expect(runnerCalls).toEqual(['npm install -g @openai/codex']);
  });

  it('installs an install-only CLI (grok) and launches are rejected with a clear message', async () => {
    const install = await adminFetch('POST', '/admin/api/cli/grok/install');
    expect(install.status).toBe(200);
    expect(runnerCalls).toEqual(['npm install -g @xai-official/grok']);

    const launch = await adminFetch('POST', '/admin/api/cli/grok/launch', {});
    expect(launch.status).toBe(400);
    expect(launch.text).toMatch(/install-only/i);
    expect(openerCalls).toHaveLength(0);
  });

  it('upgrades a CLI to @latest and re-probes the landed version', async () => {
    versionOutputs = { 'codex --version': 'codex-cli 0.60.0\n' };
    const r = await adminFetch('POST', '/admin/api/cli/codex/upgrade');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, version: '0.60.0' });
    expect(runnerCalls).toEqual(['npm install -g @openai/codex@latest']);
  });

  it('reports an upgrade failure as 500 with the reason', async () => {
    runnerOk = false;
    const r = await adminFetch('POST', '/admin/api/cli/claude/upgrade');
    expect(r.status).toBe(500);
    expect(r.text).toMatch(/boom: npm ENOENT/);
    expect(runnerCalls).toEqual(['npm install -g @anthropic-ai/claude-code@latest']);
  });

  it('rejects upgrading an unknown cli id (400)', async () => {
    const r = await adminFetch('POST', '/admin/api/cli/notacli/upgrade');
    expect(r.status).toBe(400);
    expect(runnerCalls).toHaveLength(0);
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

/** Create a gateway key with a client's permissions; optionally bind it to that client's endpoint route. */
async function makeRoutedKey(options?: {
  permissions?: string[];
  bind?: boolean;
  client?: 'codex' | 'claude';
  /** Create an INTEGRATION row instead — the only kind whose endpoint
   *  permissions still scope anything (client keys hold all permissions). */
  integration?: boolean;
}): Promise<{ id: string; name: string; plaintext: string }> {
  const client = options?.client ?? 'codex';
  const permissions = (options?.permissions ??
    (client === 'claude' ? ['messages'] : ['responses', 'images'])) as OutboundPermission[];
  const created = options?.integration
    ? await createIntegrationKey(daemon.keyDb, 'route-key', permissions)
    : await createNamedKey(daemon.keyDb, 'route-key');
  if (!options?.integration) {
    await daemon.keyDb.outboundApiKeysSetPermissions(created.id, permissions);
  }
  if (options?.bind !== false) {
    const current = await loadServerConfig(daemon.settingsStore);
    const binding: GatewayBinding = {
      id: client === 'claude' ? 'test-messages-route' : 'test-responses-route',
      name: client === 'claude' ? 'Test messages route' : 'Test responses route',
      enabled: true,
      keyScope: 'selected',
      apiKeyIds: [created.id],
      endpoint: client === 'claude' ? 'messages' : 'responses',
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

describe('Key-scoped codex launch', () => {
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

  it('rejects a key-scoped launch for a CLI outside codex/claude (400)', async () => {
    const key = await makeRoutedKey();
    const r = await adminFetch('POST', '/admin/api/cli/qwen/launch', { keyId: key.id });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/only supported for codex and claude/i);
    expect(openerCalls).toHaveLength(0);
  });

  it('rejects an unknown key id (404)', async () => {
    await makeRoutedKey();
    const r = await adminFetch('POST', '/admin/api/cli/codex/launch', { keyId: 'oak_missing' });
    expect(r.status).toBe(404);
    expect(r.text).toMatch(/does not exist/i);
    expect(openerCalls).toHaveLength(0);
  });

  it('rejects an integration key without codex endpoint permissions (400)', async () => {
    const key = await makeRoutedKey({ permissions: ['responses'], bind: false, integration: true });
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

describe('Route-pinned codex launch', () => {
  async function applyBindings(bindings: GatewayBinding[]): Promise<void> {
    const current = await loadServerConfig(daemon.settingsStore);
    await saveServerConfig(daemon.settingsStore, { ...current, bindings });
    await daemon.outboundApiServer.applyConfig({
      enabled: true,
      networkBinding: current.networkBinding,
      endpoints: current.endpoints,
      bindings,
      port: current.port,
    });
  }

  it('launches codex pinned to a downstream route: auto-picked key + pin header, no secret anywhere', async () => {
    const key = await makeRoutedKey();
    const r = await adminFetch('POST', '/admin/api/cli/codex/launch', {
      bindingId: 'test-responses-route',
    });
    expect(r.status).toBe(200);
    const out = r.json as {
      sessionId: string;
      keyId: string;
      keyName: string;
      bindingId: string;
      bindingName: string;
    };
    expect(out.keyId).toBe(key.id);
    expect(out.keyName).toBe(key.name);
    expect(out.bindingId).toBe('test-responses-route');
    expect(out.bindingName).toBe('Test responses route');

    // The opener received the -c overrides carrying the route pin header.
    expect(openerCalls).toHaveLength(1);
    const args = openerCalls[0].extraArgs;
    const headers = args.find((a) => a.startsWith('model_providers.omnicross.http_headers='));
    expect(headers).toContain('"x-omnicross-binding-id"="test-responses-route"');
    expect(JSON.stringify(openerCalls[0])).not.toContain(key.plaintext);
    expect(r.text).not.toContain(key.plaintext);

    // The session row is route-labelled and stoppable.
    const list = await adminFetch('GET', '/admin/api/cli/sessions');
    const sessions = (list.json as {
      sessions: Array<{ bindingName?: string; keyName?: string }>;
    }).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].bindingName).toBe('Test responses route');
    expect(sessions[0].keyName).toBe(key.name);
    const stop = await adminFetch('DELETE', `/admin/api/cli/sessions/${out.sessionId}`);
    expect(stop.status).toBe(200);
  });

  it('honors an explicit keyId for the pinned route, rejecting a key that cannot enter it', async () => {
    const bound = await makeRoutedKey();
    const outsider = await makeRoutedKey({ bind: false });
    const ok = await adminFetch('POST', '/admin/api/cli/codex/launch', {
      bindingId: 'test-responses-route',
      keyId: bound.id,
    });
    expect(ok.status).toBe(200);

    const rejected = await adminFetch('POST', '/admin/api/cli/codex/launch', {
      bindingId: 'test-responses-route',
      keyId: outsider.id,
    });
    expect(rejected.status).toBe(400);
    expect(rejected.text).toMatch(/cannot enter downstream route/i);
  });

  it('rejects a route-scoped launch for a CLI outside codex/claude (400)', async () => {
    await makeRoutedKey();
    const r = await adminFetch('POST', '/admin/api/cli/qwen/launch', {
      bindingId: 'test-responses-route',
    });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/only supported for codex and claude/i);
    expect(openerCalls).toHaveLength(0);
  });

  it('rejects an unknown route id (404)', async () => {
    await makeRoutedKey();
    const r = await adminFetch('POST', '/admin/api/cli/codex/launch', { bindingId: 'ghost-route' });
    expect(r.status).toBe(404);
    expect(r.text).toMatch(/does not exist/i);
    expect(openerCalls).toHaveLength(0);
  });

  it('rejects a route that is disabled or does not serve responses (400)', async () => {
    await makeRoutedKey();
    await applyBindings([
      {
        id: 'chat-only-route',
        name: 'Chat only',
        enabled: true,
        keyScope: 'all',
        endpoint: 'chat',
        target: { kind: 'provider', providerId: 'mock' },
        priority: 100,
        fallback: 'fail',
        modelMode: 'passthrough',
      },
    ]);
    const r = await adminFetch('POST', '/admin/api/cli/codex/launch', { bindingId: 'chat-only-route' });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/does not serve the responses endpoint/i);
    expect(openerCalls).toHaveLength(0);
  });

  it('rejects a route no eligible key can enter (400)', async () => {
    await applyBindings([
      {
        id: 'open-route',
        name: 'Open route',
        enabled: true,
        keyScope: 'all',
        endpoint: 'responses',
        target: { kind: 'provider', providerId: 'mock' },
        priority: 100,
        fallback: 'fail',
        modelMode: 'passthrough',
      },
    ]);
    const r = await adminFetch('POST', '/admin/api/cli/codex/launch', { bindingId: 'open-route' });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/no eligible gateway key/i);
    expect(openerCalls).toHaveLength(0);
  });

  it('rejects a route id the terminal cannot carry (400)', async () => {
    const r = await adminFetch('POST', '/admin/api/cli/codex/launch', { bindingId: 'bad id!' });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/cannot be passed through a terminal launch/i);
    expect(openerCalls).toHaveLength(0);
  });
});

describe('Key/route-scoped Claude Code launch', () => {
  it('launches claude scoped to a gateway key: redirect env, no secret in the response', async () => {
    const key = await makeRoutedKey({ client: 'claude' });
    const r = await adminFetch('POST', '/admin/api/cli/claude/launch', { keyId: key.id });
    expect(r.status).toBe(200);
    const out = r.json as { sessionId: string; keyId: string; keyName: string };
    expect(out.keyId).toBe(key.id);
    expect(out.keyName).toBe(key.name);

    // The opener received the gateway-redirect env; Claude Code has no helper
    // hook, so the key rides the spawned env (never the response).
    expect(openerCalls).toHaveLength(1);
    const call = openerCalls[0];
    expect(call.cli).toBe('claude');
    expect(call.extraArgs).toEqual([]);
    expect(call.env['ANTHROPIC_BASE_URL']).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(call.env['ANTHROPIC_AUTH_TOKEN']).toBe(key.plaintext);
    expect(call.env['ANTHROPIC_API_KEY']).toBe('omnicross-gateway');
    expect(call.env['ANTHROPIC_CUSTOM_HEADERS']).toBeUndefined();
    expect(r.text).not.toContain(key.plaintext);

    const list = await adminFetch('GET', '/admin/api/cli/sessions');
    const sessions = (list.json as { sessions: Array<{ keyName?: string }> }).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].keyName).toBe(key.name);
    const stop = await adminFetch('DELETE', `/admin/api/cli/sessions/${out.sessionId}`);
    expect(stop.status).toBe(200);
  });

  it('launches claude pinned to a messages route: pin header rides ANTHROPIC_CUSTOM_HEADERS', async () => {
    const key = await makeRoutedKey({ client: 'claude' });
    const r = await adminFetch('POST', '/admin/api/cli/claude/launch', {
      bindingId: 'test-messages-route',
    });
    expect(r.status).toBe(200);
    const out = r.json as {
      sessionId: string;
      keyId: string;
      bindingId: string;
      bindingName: string;
    };
    expect(out.keyId).toBe(key.id);
    expect(out.bindingId).toBe('test-messages-route');
    expect(out.bindingName).toBe('Test messages route');

    expect(openerCalls).toHaveLength(1);
    // `Name: Value` format (Claude Code ≥ v2.1.227), newline-separated for more.
    expect(openerCalls[0].env['ANTHROPIC_CUSTOM_HEADERS']).toBe(
      'x-omnicross-binding-id: test-messages-route',
    );
    expect(r.text).not.toContain(key.plaintext);
  });

  it('rejects a claude integration key without the messages permission (400)', async () => {
    const key = await makeRoutedKey({ client: 'claude', permissions: ['responses'], bind: false, integration: true });
    const r = await adminFetch('POST', '/admin/api/cli/claude/launch', { keyId: key.id });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/lacks the 'messages' endpoint permission claude requires/i);
    expect(openerCalls).toHaveLength(0);
  });

  it('rejects pinning claude to a responses-endpoint route (400)', async () => {
    await makeRoutedKey();
    const r = await adminFetch('POST', '/admin/api/cli/claude/launch', {
      bindingId: 'test-responses-route',
    });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/does not serve the messages endpoint/i);
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

  it('appends the route pin header when a binding is pinned', () => {
    const args = buildKeyScopedCodexArgs({
      gatewayBaseUrl: 'http://127.0.0.1:8765/',
      authHelper: { command: 'node', args: ['cli.js'] },
      keyId: 'oak_1',
      bindingId: 'route-9',
    });
    expect(args).toContain(
      'model_providers.omnicross.http_headers={"X-OpenAI-Actor-Authorization"="omnicross","x-omnicross-binding-id"="route-9"}',
    );
  });
});

