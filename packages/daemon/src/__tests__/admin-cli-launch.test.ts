/**
 * admin-cli-launch.test.ts — the dashboard "launch a coding CLI" admin routes.
 *
 *  - GET /admin/api/cli                 → per-CLI availability (PATH probe).
 *  - POST /admin/api/cli/:cli/launch    → register the resident route + open a
 *                                         terminal with the redirect env.
 *  - GET /admin/api/cli/sessions        → list running launches.
 *  - DELETE /admin/api/cli/sessions/:id → stop (remove the route).
 *
 * The PATH probe + terminal opener are injected (test seams) so the test never
 * spawns a real window. SECRET SPINE asserted: the route token rides ONLY the
 * spawned terminal's env — it NEVER appears in any response body.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadServerConfig } from '@omnicross/core/outbound-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type CommandRunner, resetCliSessions, type TerminalOpener } from '../admin/cliLaunch';
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

/** Fake PATH: claude is "installed", everything else is not. */
const fakeProbe = (candidate: string): string | null =>
  candidate.includes('claude') ? `/fake/bin/${candidate}` : null;

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
        { endpoint: 'chat', defaultModel: 'mock,mock-model', backgroundModel: 'mock,mock-model', useSubscription: false },
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
    expect(clis.find((c) => c.id === 'codex')?.installed).toBe(false);
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
    const r = await adminFetch('POST', '/admin/api/cli/codex/launch', {});
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
