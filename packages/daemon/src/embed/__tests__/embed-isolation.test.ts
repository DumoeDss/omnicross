/**
 * Embedding entry acceptance §7.1 — a minimal host that imports ONLY
 * `@omnicross/daemon/embed`:
 *  - starts no gateway (8765) or admin (8766) listener — the only new listening
 *    socket is the provider proxy;
 *  - writes nothing outside `dataDir` (HOME is sandboxed to catch home writes);
 *  - does not read `OMNICROSS_MASTER_KEY` when `readEnv` is false (the default);
 *  - never loads `sharp` or `jsdom` at import, start, or through the admin flows.
 */

import { existsSync, readFileSync } from 'node:fs';
import { Server } from 'node:net';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loaded = vi.hoisted(() => ({ sharp: false, jsdom: false }));

vi.mock('sharp', () => {
  loaded.sharp = true;
  return { default: () => { throw new Error('sharp must not be used by the embed host'); } };
});
vi.mock('jsdom', () => {
  loaded.jsdom = true;
  return { JSDOM: class { constructor() { throw new Error('jsdom must not be used by the embed host'); } } };
});

import { createEmbeddedHost, type EmbeddedHost } from '@omnicross/daemon/embed';

import { createSandbox, type MockUpstream, type Sandbox, startMockUpstream } from './embedFixture';

/** Ports of every listening net.Server in this process. */
function listeningPorts(): number[] {
  const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
  return handles
    .filter((handle): handle is Server => handle instanceof Server && handle.listening)
    .map((server) => {
      const address = server.address();
      return typeof address === 'object' && address ? address.port : -1;
    });
}

const ENV_KEY_HEX = 'ab'.repeat(32);

let sandbox: Sandbox;
let upstream: MockUpstream;
let host: EmbeddedHost | undefined;

beforeEach(async () => {
  sandbox = createSandbox();
  upstream = await startMockUpstream();
  vi.stubEnv('HOME', sandbox.home);
  vi.stubEnv('USERPROFILE', sandbox.home);
  vi.stubEnv('OMNICROSS_MASTER_KEY', ENV_KEY_HEX);
});

afterEach(async () => {
  await host?.stop();
  host = undefined;
  await upstream.close();
  vi.unstubAllEnvs();
  sandbox.cleanup();
});

describe('embedded host isolation (§7.1)', () => {
  it('importing the embed entry loads neither sharp nor jsdom', () => {
    expect(loaded).toEqual({ sharp: false, jsdom: false });
  });

  it('starts only the provider proxy: no 8765/8766, no other listener', async () => {
    const before = new Set(listeningPorts());
    host = createEmbeddedHost({ dataDir: sandbox.dataDir });
    await host.start();
    const added = listeningPorts().filter((port) => !before.has(port));
    const proxyPort = Number(new URL(host.proxyBaseUrl!).port);
    expect(added).toEqual([proxyPort]);
    expect(added).not.toContain(8765);
    expect(added).not.toContain(8766);
    expect((await host.health()).ready).toBe(true);
  });

  it('honors a pinned proxy port and reports it', async () => {
    const probe = await startMockUpstream();
    const port = probe.port;
    await probe.close();
    host = createEmbeddedHost({ dataDir: sandbox.dataDir, proxy: { host: '127.0.0.1', port } });
    await host.start();
    expect(host.proxyBaseUrl).toBe(`http://127.0.0.1:${port}`);
  });

  it('writes only inside dataDir across provider, key and account flows, and ignores the env master key', async () => {
    host = createEmbeddedHost({ dataDir: sandbox.dataDir });
    await host.start();

    await host.providers.create({
      id: 'byo',
      apiFormat: 'openai',
      baseUrl: `${upstream.url}/v1`,
      apiKey: 'sk-secret-1234',
    });
    await host.providers.keys.add('byo', { apiKey: 'sk-pool-5678', label: 'pool' });
    await host.accounts.addManual('claude', {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: 'claude-access-token',
      refreshToken: 'claude-refresh-token',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      label: 'Work',
    });
    await host.stop();
    host = undefined;

    expect(sandbox.filesOutsideDataDir()).toEqual([]);
    expect(sandbox.dataDirFiles()).toEqual(['config.json', 'master.key', 'tokens.json']);

    // The key file in dataDir was generated (the env key was not used) and
    // secrets are encrypted at rest with it — never stored in plaintext.
    const keyFile = readFileSync(join(sandbox.dataDir, 'master.key'));
    expect(keyFile.length).toBe(32);
    expect(keyFile.equals(Buffer.from(ENV_KEY_HEX, 'hex'))).toBe(false);
    const config = readFileSync(join(sandbox.dataDir, 'config.json'), 'utf8');
    expect(config).not.toContain('sk-secret-1234');
    expect(config).not.toContain('sk-pool-5678');
    expect(readFileSync(join(sandbox.dataDir, 'tokens.json'), 'utf8')).not.toContain('claude-access-token');

    // A fresh host over the same dataDir decrypts with the file key.
    host = createEmbeddedHost({ dataDir: sandbox.dataDir });
    const [provider] = await host.providers.list();
    expect(provider.hasApiKey).toBe(true);
    expect(provider.apiKeyMasked).toBe('sk-…1234');

    // Nothing touched sharp/jsdom along the way.
    expect(loaded).toEqual({ sharp: false, jsdom: false });
  });

  it('uses OMNICROSS_MASTER_KEY only when readEnv is true', async () => {
    host = createEmbeddedHost({ dataDir: sandbox.dataDir, masterKey: { readEnv: true } });
    await host.providers.create({ id: 'byo', apiFormat: 'gemini', baseUrl: upstream.url, apiKey: 'sk-env-key' });
    await host.stop();
    host = undefined;
    expect(existsSync(join(sandbox.dataDir, 'master.key'))).toBe(false);
  });

  // Runs after every flag assertion: proves the module mocks above really
  // observe a load, so the "not loaded" assertions are not vacuous.
  it('control: the probes flip when sharp / jsdom are actually loaded', async () => {
    const { loadSharp } = await import('@omnicross/core/image-generation');
    await loadSharp();
    await import('jsdom');
    expect(loaded).toEqual({ sharp: true, jsdom: true });
  });

  it('allows one host per process and frees the slot on stop', async () => {
    host = createEmbeddedHost({ dataDir: sandbox.dataDir });
    expect(() => createEmbeddedHost({ dataDir: sandbox.dataDir })).toThrow(/already active/);
    await host.stop();
    host = createEmbeddedHost({ dataDir: sandbox.dataDir });
    await host.start();
    expect(host.proxyBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
