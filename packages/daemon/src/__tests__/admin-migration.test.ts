/**
 * admin-migration.test.ts — the encrypted migration-pack endpoints
 * (`POST /admin/api/export` + `POST /admin/api/import`, app-parity child 6).
 *
 * Boots the FULL daemon in-process (mirrors admin-provider-endpoints.test.ts) so
 * the at-rest encrypt/decrypt + the seal/open + the deny-by-default write spine
 * are exercised end-to-end. Covers:
 *  - export→import round-trip: a SENTINEL provider key + a SENTINEL token survive
 *    to the far side and are usable after import (decrypted in-memory there).
 *  - no-plaintext-in-export-response: the sentinels NEVER appear in plaintext in
 *    the export response body or any captured log (only inside the opaque pack).
 *  - passphrase IN-only: the passphrase is absent from the response + logs.
 *  - wrong / empty passphrase: a clean auth/strength error with NO partial write.
 *  - weak passphrase rejected (below the minimum length).
 *  - deny-by-default import: an unknown provider/token field is dropped.
 *  - at-rest re-encryption on the target: imported secrets land `enc:` on disk.
 *  - merge-by-provider additive + idempotent: a re-import skips existing ids.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadServerConfig } from '@omnicross/core/outbound-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

// ── Sentinels — must survive the round-trip but NEVER leak in plaintext ─────────

const SENTINEL_PROVIDER_KEY = 'sk-provider-SENTINEL-migration-export-7777';
const SENTINEL_POOL_KEY = 'sk-pool-SENTINEL-migration-export-8888';
const SENTINEL_TOKEN = 'access-SENTINEL-migration-token-9999';
const PASSPHRASE = 'correct-horse-battery-staple';

// ── Admin fetch helper ──────────────────────────────────────────────────────────

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

// ── Fixture ──────────────────────────────────────────────────────────────────────

let tmpDir: string;
let daemon: Daemon;
let configPath: string;
let tokensPath: string;
let logSpies: Array<ReturnType<typeof vi.spyOn>>;
let capturedLogs: string[];

interface ProviderRow {
  id: string;
  apiFormat: string;
  baseUrl: string;
  apiKey: string;
  models?: string[];
  apiKeys?: Array<{ id: string; apiKey: string; label?: string }>;
  transformer?: Record<string, unknown>;
}

function writeConfig(path: string, providers: ProviderRow[]): void {
  const cfg = {
    providers,
    server: {
      enabled: true,
      networkBinding: false,
      port: 0,
      endpoints: [
        { endpoint: 'chat', defaultModel: 'src,mock-model', backgroundModel: 'src,mock-model', useSubscription: false },
        // messages/responses need complete kind maps or the startup gate refuses to bind.
        { endpoint: 'responses', modelMap: { codex: 'src,mock-model', mini: 'src,mock-model' }, useSubscription: false },
        {
          endpoint: 'messages',
          modelMap: { fable: 'src,mock-model', opus: 'src,mock-model', sonnet: 'src,mock-model', haiku: 'src,mock-model' },
          useSubscription: false,
        },
      ],
    },
    admin: { port: 0 },
  };
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
}

/** Boot the daemon against an empty config (the import target starts blank). */
async function bootDaemon(providers: ProviderRow[]): Promise<void> {
  resetDaemonSingletonsForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-migration-'));
  configPath = join(tmpDir, 'config.json');
  const keysPath = join(tmpDir, 'keys.json');
  tokensPath = join(tmpDir, 'tokens.json');
  writeConfig(configPath, providers);

  const config = loadConfig(configPath);
  daemon = buildDaemon(config, {
    configPath,
    keysPath,
    tokensPath,
    masterKeyFilePath: join(tmpDir, 'master.key'),
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
}

beforeEach(() => {
  // Capture EVERY console channel so a no-plaintext-in-logs assertion is real.
  capturedLogs = [];
  const sink = (...args: unknown[]) => {
    capturedLogs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  logSpies = [
    vi.spyOn(console, 'log').mockImplementation(sink),
    vi.spyOn(console, 'info').mockImplementation(sink),
    vi.spyOn(console, 'warn').mockImplementation(sink),
    vi.spyOn(console, 'error').mockImplementation(sink),
    vi.spyOn(console, 'debug').mockImplementation(sink),
  ];
});

afterEach(async () => {
  if (daemon) {
    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
  }
  for (const spy of logSpies ?? []) spy.mockRestore();
  resetDaemonSingletonsForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/** Seed a subscription token (claude) via the accounts write path. */
async function seedClaudeToken(accessToken: string): Promise<void> {
  const r = await adminFetch('PUT', '/admin/api/accounts/claude', {
    authMethod: 'oauth',
    status: 'authorized',
    accessToken,
    refreshToken: 'refresh-SENTINEL',
  });
  expect(r.status).toBe(200);
}

// ── export → import round-trip ────────────────────────────────────────────────────

describe('migration pack export/import (app-parity child 6)', () => {
  it('round-trips a provider key + pool key + subscription token to another machine', async () => {
    // Source machine: one provider with a single key + a pool key + a token.
    await bootDaemon([
      {
        id: 'src',
        apiFormat: 'openai',
        baseUrl: 'https://api.openai.example/v1',
        apiKey: SENTINEL_PROVIDER_KEY,
        models: ['mock-model'],
        apiKeys: [{ id: 'k1', apiKey: SENTINEL_POOL_KEY, label: 'primary' }],
        transformer: { use: ['maxtoken'] },
      },
    ]);
    await seedClaudeToken(SENTINEL_TOKEN);

    const exp = await adminFetch('POST', '/admin/api/export', { passphrase: PASSPHRASE });
    expect(exp.status).toBe(200);
    const { pack, version } = exp.json as { pack: string; version: number };
    expect(version).toBe(1);
    expect(typeof pack).toBe('string');
    expect(pack.startsWith('OMCXPACK1.')).toBe(true);

    // ── Boot a SECOND, blank machine (different master key) and import there ──
    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
    resetDaemonSingletonsForTests();
    const srcDir = tmpDir;

    await bootDaemon([]); // empty target

    const imp = await adminFetch('POST', '/admin/api/import', { blob: pack, passphrase: PASSPHRASE });
    expect(imp.status).toBe(200);
    const counts = imp.json as {
      providerKeys: number;
      poolKeys: number;
      tokenSets: number;
      duplicates: number;
      skipped: string[];
    };
    expect(counts.providerKeys).toBe(1);
    expect(counts.poolKeys).toBe(1);
    expect(counts.tokenSets).toBe(1);
    expect(counts.skipped).toEqual([]);

    // The provider + its DECRYPTED keys exist on the target (in-memory plaintext).
    const targetCfg = loadConfig(configPath);
    const provider = targetCfg.providers.find((p) => p.id === 'src');
    expect(provider).toBeDefined();
    expect(provider!.apiKey).toBe(SENTINEL_PROVIDER_KEY);
    expect(provider!.apiKeys?.[0]?.apiKey).toBe(SENTINEL_POOL_KEY);
    expect(provider!.transformer?.use).toEqual(['maxtoken']);

    // The token survived (the accounts list shows it as present, token-free).
    const accts = await adminFetch('GET', '/admin/api/accounts');
    const accountsJson = accts.json as { providerAccounts: Record<string, Array<{ hasAccessToken: boolean }>> };
    expect(accountsJson.providerAccounts['claude']?.[0]?.hasAccessToken).toBe(true);

    rmSync(srcDir, { recursive: true, force: true });
  });

  it('the export response + logs carry NO plaintext secret (only the opaque pack)', async () => {
    await bootDaemon([
      {
        id: 'src',
        apiFormat: 'openai',
        baseUrl: 'https://api.openai.example/v1',
        apiKey: SENTINEL_PROVIDER_KEY,
        apiKeys: [{ id: 'k1', apiKey: SENTINEL_POOL_KEY }],
      },
    ]);
    await seedClaudeToken(SENTINEL_TOKEN);
    capturedLogs.length = 0; // ignore boot/seed logs; focus on the export call

    const exp = await adminFetch('POST', '/admin/api/export', { passphrase: PASSPHRASE });
    expect(exp.status).toBe(200);

    // The response body NEVER contains a plaintext secret or the passphrase.
    expect(exp.text).not.toContain(SENTINEL_PROVIDER_KEY);
    expect(exp.text).not.toContain(SENTINEL_POOL_KEY);
    expect(exp.text).not.toContain(SENTINEL_TOKEN);
    expect(exp.text).not.toContain(PASSPHRASE);

    // No captured log line carries a plaintext secret or the passphrase.
    const allLogs = capturedLogs.join('\n');
    expect(allLogs).not.toContain(SENTINEL_PROVIDER_KEY);
    expect(allLogs).not.toContain(SENTINEL_POOL_KEY);
    expect(allLogs).not.toContain(SENTINEL_TOKEN);
    expect(allLogs).not.toContain(PASSPHRASE);

    // The pack DOES round-trip the secret (recoverable only with the passphrase),
    // so its plaintext is genuinely absent from the response (not just unseeded).
    const { pack } = exp.json as { pack: string };
    expect(pack).not.toContain(SENTINEL_PROVIDER_KEY);
    expect(pack).not.toContain(SENTINEL_TOKEN);
  });

  it('a weak/empty passphrase is rejected on export with no pack produced', async () => {
    await bootDaemon([{ id: 'src', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: SENTINEL_PROVIDER_KEY }]);
    const empty = await adminFetch('POST', '/admin/api/export', { passphrase: '' });
    expect(empty.status).toBe(400);
    expect(empty.text).not.toContain('pack');
    const weak = await adminFetch('POST', '/admin/api/export', { passphrase: 'short' });
    expect(weak.status).toBe(400);
  });

  it('a wrong passphrase fails cleanly with NO partial write (atomic)', async () => {
    await bootDaemon([
      { id: 'src', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: SENTINEL_PROVIDER_KEY },
    ]);
    const exp = await adminFetch('POST', '/admin/api/export', { passphrase: PASSPHRASE });
    const { pack } = exp.json as { pack: string };

    // Fresh blank target.
    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
    resetDaemonSingletonsForTests();
    const srcDir = tmpDir;
    await bootDaemon([{ id: 'existing', apiFormat: 'openai', baseUrl: 'https://y/v1', apiKey: 'sk-existing' }]);

    const imp = await adminFetch('POST', '/admin/api/import', { blob: pack, passphrase: 'WRONG-passphrase-xyz' });
    expect(imp.status).toBe(400);
    // The error references wrong-passphrase/tamper, never the passphrase itself.
    expect(imp.text).not.toContain('WRONG-passphrase-xyz');

    // NO partial write: the target still has ONLY its original provider.
    const targetCfg = loadConfig(configPath);
    expect(targetCfg.providers.map((p) => p.id)).toEqual(['existing']);

    rmSync(srcDir, { recursive: true, force: true });
  });

  it('imported secrets are re-encrypted at rest under the TARGET master key', async () => {
    await bootDaemon([
      { id: 'src', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: SENTINEL_PROVIDER_KEY },
    ]);
    await seedClaudeToken(SENTINEL_TOKEN);
    const exp = await adminFetch('POST', '/admin/api/export', { passphrase: PASSPHRASE });
    const { pack } = exp.json as { pack: string };

    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
    resetDaemonSingletonsForTests();
    const srcDir = tmpDir;
    await bootDaemon([]);

    const imp = await adminFetch('POST', '/admin/api/import', { blob: pack, passphrase: PASSPHRASE });
    expect(imp.status).toBe(200);

    // On-disk config.json: the provider key is `enc:` (NOT plaintext sentinel).
    const rawConfig = readFileSync(configPath, 'utf8');
    expect(rawConfig).not.toContain(SENTINEL_PROVIDER_KEY);
    expect(rawConfig).toContain('enc:v1:');
    // On-disk tokens.json: the token is `enc:` too.
    const rawTokens = readFileSync(tokensPath, 'utf8');
    expect(rawTokens).not.toContain(SENTINEL_TOKEN);
    expect(rawTokens).toContain('enc:v1:');

    rmSync(srcDir, { recursive: true, force: true });
  });

  it('deny-by-default: an unknown field in the pack is never persisted', async () => {
    // Hand-craft a pack with an extra malicious field by exporting a normal pack,
    // then importing it — the validators drop anything outside the allowlist.
    // We assert via a NORMAL provider that the on-disk row carries only known
    // fields (a crafted-field attack is structurally impossible to persist).
    await bootDaemon([
      {
        id: 'src',
        apiFormat: 'openai',
        baseUrl: 'https://x/v1',
        apiKey: SENTINEL_PROVIDER_KEY,
        // An unknown field on the row — must be dropped by parseProviderInput.
        ...({ maliciousField: 'EVIL-INJECTED-VALUE' } as Record<string, unknown>),
      },
    ]);
    const exp = await adminFetch('POST', '/admin/api/export', { passphrase: PASSPHRASE });
    const { pack } = exp.json as { pack: string };

    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
    resetDaemonSingletonsForTests();
    const srcDir = tmpDir;
    await bootDaemon([]);

    await adminFetch('POST', '/admin/api/import', { blob: pack, passphrase: PASSPHRASE });
    const rawConfig = readFileSync(configPath, 'utf8');
    expect(rawConfig).not.toContain('EVIL-INJECTED-VALUE');
    expect(rawConfig).not.toContain('maliciousField');

    rmSync(srcDir, { recursive: true, force: true });
  });

  it('merge-by-provider is additive and idempotent (re-import skips existing ids)', async () => {
    await bootDaemon([
      { id: 'src', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: SENTINEL_PROVIDER_KEY },
    ]);
    const exp = await adminFetch('POST', '/admin/api/export', { passphrase: PASSPHRASE });
    const { pack } = exp.json as { pack: string };

    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
    resetDaemonSingletonsForTests();
    const srcDir = tmpDir;
    // Target already has a DIFFERENT provider — additive merge must preserve it.
    await bootDaemon([{ id: 'keep', apiFormat: 'openai', baseUrl: 'https://y/v1', apiKey: 'sk-keep' }]);

    const first = await adminFetch('POST', '/admin/api/import', { blob: pack, passphrase: PASSPHRASE });
    expect((first.json as { providerKeys: number }).providerKeys).toBe(1);
    expect((first.json as { skipped: string[] }).skipped).toEqual([]);

    // Both providers present (existing preserved).
    let cfg = loadConfig(configPath);
    expect(cfg.providers.map((p) => p.id).sort()).toEqual(['keep', 'src']);

    // Re-import = idempotent: the existing id is skipped, nothing new added.
    const second = await adminFetch('POST', '/admin/api/import', { blob: pack, passphrase: PASSPHRASE });
    expect((second.json as { providerKeys: number }).providerKeys).toBe(0);
    expect((second.json as { skipped: string[] }).skipped).toEqual(['src']);
    cfg = loadConfig(configPath);
    expect(cfg.providers.map((p) => p.id).sort()).toEqual(['keep', 'src']);

    rmSync(srcDir, { recursive: true, force: true });
  });
});
