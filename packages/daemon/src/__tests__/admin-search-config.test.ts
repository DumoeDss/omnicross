import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { OutboundApiServerConfig } from '@omnicross/core/outbound-api';

import {
  buildDaemon,
  type Daemon,
  type DaemonPaths,
  resetDaemonSingletonsForTests,
} from '../bootstrap';
import { loadConfig } from '../config';

const KEY_SENTINEL = 'PLANTED_TAVILY_KEY_SENTINEL';
const NEW_KEY = 'ROTATED_TAVILY_KEY_SENTINEL';
const PASSWORD_SENTINEL = 'PLACED_SEARXNG_PASSWORD_SENTINEL';

let daemon: Daemon | undefined;
let tempHome: string | undefined;
let adminBase = '';

async function bootDaemon(): Promise<void> {
  resetDaemonSingletonsForTests();
  tempHome = mkdtempSync(join(tmpdir(), 'omnicross-admin-search-config-'));
  const configPath = join(tempHome, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    providers: [],
    server: { enabled: false, networkBinding: false, port: 0, endpoints: [] },
    admin: { port: 0 },
  }, null, 2), 'utf8');
  daemon = buildDaemon(loadConfig(configPath), {
    configPath,
    keysPath: join(tempHome, 'keys.json'),
    tokensPath: join(tempHome, 'tokens.json'),
    masterKeyFilePath: join(tempHome, 'master.key'),
  });
  await daemon.llmConfig.ready();
  await daemon.adminServer.start();
  adminBase = daemon.adminServer.getStatus().url as string;
}

async function adminFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; json: unknown }> {
  const response = await fetch(`${adminBase}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

async function getServer(): Promise<OutboundApiServerConfig> {
  const response = await adminFetch('GET', '/admin/api/server');
  expect(response.status).toBe(200);
  return (response.json as { server: OutboundApiServerConfig }).server;
}

/** The persisted store of record — the daemon's config.json `server` field. */
function persistedSearch(): { providers?: Record<string, Record<string, unknown>> } {
  const raw = JSON.parse(readFileSync(join(tempHome!, 'config.json'), 'utf8')) as {
    server?: { search?: { providers?: Record<string, Record<string, unknown>> } };
  };
  return raw.server?.search ?? {};
}

afterEach(async () => {
  if (daemon) {
    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    daemon.apiKeyPool.dispose();
  }
  daemon = undefined;
  resetDaemonSingletonsForTests();
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = undefined;
});

describe('admin server-config search secret discipline', () => {
  it('never echoes a configured search secret on GET, PUT-echo, or disk; blank keeps, string sets, null clears', async () => {
    await bootDaemon();

    // 1. Plant a config with real secret VALUES via PUT (string-sets).
    const put = await adminFetch('PUT', '/admin/api/server', {
      search: {
        modes: { codex: 'managed', responses: 'native', anthropic: 'native' },
        providers: {
          tavily: { apiKey: KEY_SENTINEL },
          searxng: {
            apiHost: 'https://searx.internal.example.test',
            basicAuthUsername: 'svc',
            basicAuthPassword: PASSWORD_SENTINEL,
          },
          jina: { apiKey: KEY_SENTINEL },
        },
        egress: { allowedPrivateHosts: ['searx.internal.example.test'] },
        policy: { preferred: 'tavily', fallbackEnabled: true },
      },
    });
    expect(put.status).toBe(200);
    // The PUT echo itself is masked — no VALUE crosses the wire back.
    expect(put.text).not.toContain(KEY_SENTINEL);
    expect(put.text).not.toContain(PASSWORD_SENTINEL);
    expect((put.json as { server: { search: { providers: Record<string, unknown> } } }).server.search.providers.tavily)
      .toEqual({ apiKeyConfigured: true });

    // The values ARE persisted (the store of record keeps them — write-only).
    expect(persistedSearch().providers?.tavily?.apiKey).toBe(KEY_SENTINEL);

    // 2. GET never echoes them either.
    const masked = (await getServer()).search!;
    const maskedText = JSON.stringify(masked);
    expect(maskedText).not.toContain(KEY_SENTINEL);
    expect(maskedText).not.toContain(PASSWORD_SENTINEL);
    expect(masked.providers.tavily).toEqual({ apiKeyConfigured: true });
    expect(masked.providers.searxng).toEqual({
      apiHost: 'https://searx.internal.example.test',
      basicAuthUsername: 'svc',
      basicAuthPasswordConfigured: true,
    });
    // jina key present → marker true.
    expect((masked.providers.jina as { apiKeyConfigured?: boolean }).apiKeyConfigured).toBe(true);
    // Non-secret members round-trip unchanged.
    expect(masked.modes).toEqual({ codex: 'managed', responses: 'native', anthropic: 'native' });
    expect(masked.egress.allowedPrivateHosts).toEqual(['searx.internal.example.test']);
    expect(masked.policy).toEqual({ preferred: 'tavily', fallbackEnabled: true });

    // 3. Masked round-trip edit: change only the searxng host from the masked
    //    read (no secret fields) — the stored password survives.
    const roundTrip = await adminFetch('PUT', '/admin/api/server', {
      search: {
        ...masked,
        providers: {
          ...masked.providers,
          searxng: { ...masked.providers.searxng, apiHost: 'https://searx2.internal.example.test' },
        },
      },
    });
    expect(roundTrip.status).toBe(200);
    expect(roundTrip.text).not.toContain(PASSWORD_SENTINEL);
    expect(persistedSearch().providers?.searxng?.apiHost).toBe('https://searx2.internal.example.test');
    expect(persistedSearch().providers?.searxng?.basicAuthPassword).toBe(PASSWORD_SENTINEL);
    expect(persistedSearch().providers?.tavily?.apiKey).toBe(KEY_SENTINEL);

    // 4. Blank keeps; a new string replaces.
    const rotated = await adminFetch('PUT', '/admin/api/server', {
      search: {
        providers: {
          tavily: { apiKey: '' },
          jina: { apiKey: NEW_KEY },
        },
      },
    });
    expect(rotated.status).toBe(200);
    expect(persistedSearch().providers?.tavily?.apiKey).toBe(KEY_SENTINEL);
    expect(persistedSearch().providers?.jina?.apiKey).toBe(NEW_KEY);

    // 5. JSON null clears the OPTIONAL jina key; the entry survives keyless.
    const cleared = await adminFetch('PUT', '/admin/api/server', {
      search: { providers: { jina: { apiKey: null } } },
    });
    expect(cleared.status).toBe(200);
    expect(persistedSearch().providers?.jina).toEqual({});

    // 6. Removing an entry removes its configuration including its secret.
    const removed = await adminFetch('PUT', '/admin/api/server', {
      search: { providers: { jina: {} } },
    });
    expect(removed.status).toBe(200);
    expect(persistedSearch().providers?.tavily).toBeUndefined();

    // 7. Diagnostics + test rides the same daemon without leaking the key.
    const diagnostics = await adminFetch('GET', '/admin/api/search/diagnostics');
    expect(diagnostics.status).toBe(200);
    expect(diagnostics.text).not.toContain(KEY_SENTINEL);
    expect(diagnostics.text).not.toContain(PASSWORD_SENTINEL);
  });

  it('rejects an invalid search segment with 400 and changes nothing (atomicity)', async () => {
    await bootDaemon();

    const before = (await getServer()).search!;

    // Unknown provider id.
    const unknown = await adminFetch('PUT', '/admin/api/server', {
      search: { providers: { grok: { apiKey: 'x' } } },
    });
    expect(unknown.status).toBe(400);
    expect((unknown.json as { error: { message: string } }).error.message).toContain(
      'providers.grok: unknown search provider',
    );

    // A required key blanked out via null on a surviving entry.
    const nullCleared = await adminFetch('PUT', '/admin/api/server', {
      search: { providers: { zhipu: { apiKey: null } } },
    });
    expect(nullCleared.status).toBe(400);
    expect((nullCleared.json as { error: { message: string } }).error.message).toContain(
      'providers.zhipu.apiKey: missing or unusable',
    );

    // An out-of-range maxAttempts.
    const badAttempts = await adminFetch('PUT', '/admin/api/server', {
      search: { policy: { maxAttempts: 0 } },
    });
    expect(badAttempts.status).toBe(400);

    // Nothing changed: the next read shows the same section.
    const after = (await getServer()).search!;
    expect(after).toEqual(before);
  });

  it('masks secrets that predate this UI (a config file with plaintext keys)', async () => {
    resetDaemonSingletonsForTests();
    tempHome = mkdtempSync(join(tmpdir(), 'omnicross-admin-search-legacy-'));
    const configPath = join(tempHome, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      providers: [],
      server: {
        enabled: false,
        networkBinding: false,
        port: 0,
        endpoints: [],
        search: {
          modes: { codex: 'off', responses: 'native', anthropic: 'native' },
          providers: { tavily: { apiKey: KEY_SENTINEL } },
          egress: { allowedPrivateHosts: [] },
          policy: { fallbackEnabled: true },
        },
      },
      admin: { port: 0 },
    }, null, 2), 'utf8');
    daemon = buildDaemon(loadConfig(configPath), {
      configPath,
      keysPath: join(tempHome, 'keys.json'),
      tokensPath: join(tempHome, 'tokens.json'),
      masterKeyFilePath: join(tempHome, 'master.key'),
    });
    await daemon.llmConfig.ready();
    await daemon.adminServer.start();
    adminBase = daemon.adminServer.getStatus().url as string;

    const response = await adminFetch('GET', '/admin/api/server');
    expect(response.status).toBe(200);
    expect(response.text).not.toContain(KEY_SENTINEL);
    const search = (response.json as { server: { search: { providers: { tavily: unknown } } } }).server.search;
    expect(search.providers.tavily).toEqual({ apiKeyConfigured: true });
  });
});
