/**
 * logger-wiring.test.ts — daemon server lifecycle lines route through the
 * injected logger (configurable-logging, task 5.1).
 *
 * Proves the AdminServer's OWN lifecycle lines (bind / LAN-refuse) go through the
 * injected `ConfigurableLogger` — so they are LEVEL-FILTERED and FILE-SINKABLE
 * (not raw `console.*`). If the daemon's own logs did not route through the port,
 * the configurable logger would have nothing to act on for these lines.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminServer } from '../admin/AdminServer';
import { ConfigurableLogger } from '../ports/ConfigurableLogger';

/** Minimal AdminServer deps — only `getAdminConfig` + `logger` are touched by
 *  `start()` (no request is sent), so the rest are inert stubs. */
const minimalDeps = {
  configPath: '',
  llmConfig: {} as never,
  keyDb: {} as never,
  settingsStore: {} as never,
  outboundApiServer: {} as never,
  subscriptionAccounts: { listAll: async () => [] },
  subscriptionTokenWriter: { writeProviderTokens: async () => {}, clearProvider: async () => {} },
  apiKeyPool: { getKeyHealth: async () => ({}) },
  autoDisableStore: {} as never,
  getHealthReport: () => ({
    status: 'ok' as const,
    version: '0.0.0-dev',
    uptimeSeconds: 0,
    timestamp: new Date(0).toISOString(),
    memory: { rssMb: 0, heapUsedMb: 0 },
    checks: {},
  }),
};

let tmpDir: string;

afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('AdminServer lifecycle logs route through the injected logger', () => {
  it('the bind line is FILE-SINKABLE (appears in the logger file at level debug)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-logwire-'));
    const file = join(tmpDir, 'daemon.log');
    const logger = new ConfigurableLogger({ file, level: 'debug' });
    const server = new AdminServer({
      ...minimalDeps,
      logger,
      getAdminConfig: () => ({ enabled: true, port: 0, networkBinding: false, token: undefined }),
    });
    const port = await server.start();
    expect(port).toBeGreaterThan(0);
    await server.stop();
    await logger.close();
    expect(readFileSync(file, 'utf8')).toContain('[AdminServer] Dashboard listening');
  });

  it('the bind line is LEVEL-FILTERED (absent from the file at level=error)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-logwire-'));
    const file = join(tmpDir, 'daemon.log');
    const logger = new ConfigurableLogger({ file, level: 'error' });
    const server = new AdminServer({
      ...minimalDeps,
      logger,
      getAdminConfig: () => ({ enabled: true, port: 0, networkBinding: false, token: undefined }),
    });
    await server.start();
    await server.stop();
    await logger.close();
    // The info-level bind line is filtered out at threshold=error…
    let contents = '';
    try {
      contents = readFileSync(file, 'utf8');
    } catch {
      contents = ''; // file may never be created if nothing was written
    }
    expect(contents).not.toContain('[AdminServer] Dashboard listening');
  });

  it('the LAN fail-closed refuse is an ERROR line that reaches the file even at level=error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-logwire-'));
    const file = join(tmpDir, 'daemon.log');
    const logger = new ConfigurableLogger({ file, level: 'error' });
    const server = new AdminServer({
      ...minimalDeps,
      logger,
      // networkBinding without a token → fail-closed refuse (logs an error line).
      getAdminConfig: () => ({ enabled: true, port: 0, networkBinding: true, token: undefined }),
    });
    const port = await server.start();
    expect(port).toBe(0); // refused to bind
    await logger.close();
    expect(readFileSync(file, 'utf8')).toContain('[AdminServer] REFUSING to bind');
  });
});
