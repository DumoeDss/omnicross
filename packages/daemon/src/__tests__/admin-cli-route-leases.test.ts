import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadServerConfig } from '@omnicross/core/outbound-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleCliLaunch,
  handleCliSessions,
  handleCliStop,
  resetCliSessions,
  type TerminalOpener,
} from '../admin/cliLaunch';
import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

const UPSTREAM_KEY = 'sk-route-lease-launch-upstream-canary';

let tmpDir = '';
let configPath = '';
let keysPath = '';
let tokensPath = '';
let daemon: Daemon;
let openerThrows = false;
let legacyOpener = false;
let failReentrantly = false;
let openerCalls: Array<Parameters<TerminalOpener>[0]> = [];
let openerCleanups: Array<ReturnType<typeof vi.fn>> = [];

const opener: TerminalOpener = (input) => {
  if (openerThrows) throw new Error('terminal opener failed safely');
  openerCalls.push(input);
  if (failReentrantly) input.onFailure?.();
  if (legacyOpener) return;
  const cleanup = vi.fn();
  openerCleanups.push(cleanup);
  return cleanup;
};

const installedProbe = (candidate: string): string => `/fake/bin/${candidate}`;

function writeConfig(): void {
  writeFileSync(configPath, JSON.stringify({
    providers: [
      {
        id: 'anthropic-route',
        apiFormat: 'anthropic',
        baseUrl: 'http://127.0.0.1:9',
        apiKey: UPSTREAM_KEY,
        models: ['claude-frozen'],
      },
      {
        id: 'codex-route',
        apiFormat: 'openai-response',
        baseUrl: 'http://127.0.0.1:9',
        apiKey: UPSTREAM_KEY,
        models: ['codex-frozen'],
      },
    ],
  }, null, 2), 'utf8');
}

async function launch(cli: 'claude' | 'codex') {
  return handleCliLaunch(cli, {
    providerId: cli === 'claude' ? 'anthropic-route' : 'codex-route',
    model: cli === 'claude' ? 'claude-frozen' : 'codex-frozen',
  }, {
    llmConfig: daemon.llmConfig,
    providers: loadConfig(configPath).providers ?? [],
    routeLeaseManager: daemon.routeLeaseManager,
    opener,
    probe: installedProbe,
    platform: 'linux',
  });
}

beforeEach(async () => {
  resetDaemonSingletonsForTests();
  openerThrows = false;
  legacyOpener = false;
  failReentrantly = false;
  openerCalls = [];
  openerCleanups = [];
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-cli-route-lease-'));
  configPath = join(tmpDir, 'config.json');
  keysPath = join(tmpDir, 'keys.json');
  tokensPath = join(tmpDir, 'tokens.json');
  writeConfig();
  daemon = buildDaemon(loadConfig(configPath), {
    configPath,
    keysPath,
    tokensPath,
    masterKeyFilePath: join(tmpDir, 'master.key'),
  });
  await daemon.llmConfig.ready();
  await daemon.providerProxy.start();
});

afterEach(async () => {
  resetCliSessions();
  if (daemon) {
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
    daemon.tokenRefreshScheduler.dispose();
    daemon.claudeAllowanceRefreshScheduler.dispose();
    daemon.accountHealthSweeper.dispose();
    daemon.accountHealthProbeScheduler.dispose();
    daemon.auditPruneSweeper.dispose();
    daemon.billingRetrySweeper.dispose();
    daemon.pricingRefreshScheduler.dispose();
  }
  resetDaemonSingletonsForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('Admin CLI Route Lease composition', () => {
  it('launches Claude and Codex through one resident proxy without persistent routing or user-config writes', async () => {
    const proxyBase = daemon.providerProxy.getBaseUrl();
    const configBefore = readFileSync(configPath);
    const serverConfigBefore = await loadServerConfig(daemon.settingsStore);
    const keyRowsBefore = await daemon.keyDb.outboundApiKeysList();
    const keysExistedBefore = existsSync(keysPath);
    const tokensExistedBefore = existsSync(tokensPath);

    const claude = await launch('claude');
    const codex = await launch('codex');

    expect(claude.status).toBe(200);
    expect(codex.status).toBe(200);
    expect(daemon.providerProxy.getBaseUrl()).toBe(proxyBase);
    expect(daemon.providerProxy.routeCount()).toBe(2);
    expect(daemon.routeLeaseManager.activeCount()).toBe(2);
    expect(openerCalls).toHaveLength(2);
    expect(openerCalls[0].env.ANTHROPIC_AUTH_TOKEN).toMatch(/^[0-9a-f]{64}$/u);
    expect(openerCalls[0].env.ANTHROPIC_API_KEY).toBe('omnicross-proxy');
    expect(openerCalls[1].env.OMNICROSS_CODEX_ROUTE_TOKEN).toMatch(/^[0-9a-f]{64}$/u);
    expect(openerCalls[1].env.OPENAI_API_KEY).toBeUndefined();
    expect(openerCalls[1].extraArgs.join(' ')).toContain('env_key="OMNICROSS_CODEX_ROUTE_TOKEN"');
    expect(JSON.stringify(openerCalls)).not.toContain(UPSTREAM_KEY);

    const listed = handleCliSessions().body as {
      sessions: Array<{ id: string; cli: string; leaseId?: string }>;
    };
    expect(listed.sessions).toHaveLength(2);
    expect(listed.sessions.every((session) => Boolean(session.leaseId))).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(openerCalls[0].env.ANTHROPIC_AUTH_TOKEN);
    expect(JSON.stringify(listed)).not.toContain(openerCalls[1].env.OMNICROSS_CODEX_ROUTE_TOKEN);

    expect(readFileSync(configPath)).toEqual(configBefore);
    expect(await loadServerConfig(daemon.settingsStore)).toEqual(serverConfigBefore);
    expect(await daemon.keyDb.outboundApiKeysList()).toEqual(keyRowsBefore);
    expect(existsSync(keysPath)).toBe(keysExistedBefore);
    expect(existsSync(tokensPath)).toBe(tokensExistedBefore);
  });

  it('supports a legacy opener that returns no cleanup handle', async () => {
    legacyOpener = true;
    const result = await launch('claude');
    const id = (result.body as { sessionId: string }).sessionId;

    expect(result.status).toBe(200);
    expect(handleCliStop(id).status).toBe(200);
    expect(daemon.routeLeaseManager.activeCount()).toBe(0);
    expect(daemon.providerProxy.routeCount()).toBe(0);
  });

  it('releases authority and reports failure for a re-entrant opener callback', async () => {
    failReentrantly = true;
    const result = await launch('codex');

    expect(result.status).toBe(500);
    expect(openerCleanups[0]).toHaveBeenCalledTimes(1);
    expect(daemon.routeLeaseManager.activeCount()).toBe(0);
    expect(daemon.providerProxy.routeCount()).toBe(0);
    expect((handleCliSessions().body as { sessions: unknown[] }).sessions).toHaveLength(0);
  });

  it('removes a published session and authority after asynchronous opener failure', async () => {
    vi.useFakeTimers();
    try {
      const renew = vi.spyOn(daemon.routeLeaseManager, 'renew');
      const result = await launch('codex');
      const id = (result.body as { sessionId: string }).sessionId;

      expect(result.status).toBe(200);
      expect(daemon.routeLeaseManager.activeCount()).toBe(1);
      openerCalls[0].onFailure?.();
      openerCalls[0].onFailure?.();
      vi.advanceTimersByTime(5 * 60 * 1000);

      expect(renew).not.toHaveBeenCalled();
      expect((handleCliSessions().body as { sessions: unknown[] }).sessions).toHaveLength(0);
      expect(daemon.routeLeaseManager.activeCount()).toBe(0);
      expect(daemon.providerProxy.routeCount()).toBe(0);
      expect(openerCleanups[0]).toHaveBeenCalledTimes(1);
      expect(handleCliStop(id).status).toBe(404);
      resetCliSessions();
      expect(openerCleanups[0]).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('manual stop wins a race with a later asynchronous opener failure', async () => {
    const result = await launch('claude');
    const id = (result.body as { sessionId: string }).sessionId;

    expect(handleCliStop(id).status).toBe(200);
    openerCalls[0].onFailure?.();
    resetCliSessions();

    expect(openerCleanups[0]).toHaveBeenCalledTimes(1);
    expect(daemon.routeLeaseManager.activeCount()).toBe(0);
    expect(daemon.providerProxy.routeCount()).toBe(0);
  });

  it('releases a newly-created lease when the terminal opener fails', async () => {
    openerThrows = true;
    const result = await launch('codex');
    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({ error: { message: 'terminal opener failed safely' } });
    expect(daemon.routeLeaseManager.activeCount()).toBe(0);
    expect(daemon.providerProxy.routeCount()).toBe(0);
    expect((handleCliSessions().body as { sessions: unknown[] }).sessions).toHaveLength(0);
  });

  it('stop and reset release only their registered leases while the proxy stays resident', async () => {
    const proxyBase = daemon.providerProxy.getBaseUrl();
    const first = await launch('claude');
    const second = await launch('codex');
    const firstId = (first.body as { sessionId: string }).sessionId;
    expect(second.status).toBe(200);

    expect(handleCliStop(firstId).status).toBe(200);
    expect(openerCleanups[0]).toHaveBeenCalledTimes(1);
    expect(openerCleanups[1]).not.toHaveBeenCalled();
    expect(daemon.routeLeaseManager.activeCount()).toBe(1);
    expect(daemon.providerProxy.routeCount()).toBe(1);
    expect(daemon.providerProxy.getBaseUrl()).toBe(proxyBase);

    resetCliSessions();
    expect(openerCleanups[0]).toHaveBeenCalledTimes(1);
    expect(openerCleanups[1]).toHaveBeenCalledTimes(1);
    expect(daemon.routeLeaseManager.activeCount()).toBe(0);
    expect(daemon.providerProxy.routeCount()).toBe(0);
    expect(daemon.providerProxy.getBaseUrl()).toBe(proxyBase);
  });

  it('provider proxy shutdown releases leases and clears the session registry first', async () => {
    await launch('claude');
    await launch('codex');
    expect(daemon.routeLeaseManager.activeCount()).toBe(2);

    await daemon.providerProxy.stop();

    expect(daemon.routeLeaseManager.activeCount()).toBe(0);
    expect(daemon.providerProxy.routeCount()).toBe(0);
    expect((handleCliSessions().body as { sessions: unknown[] }).sessions).toHaveLength(0);
  });
});
