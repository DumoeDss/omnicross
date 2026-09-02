/**
 * search-settings-smoke.e2e — the task-6.2 manual smoke, executable: boots a
 * REAL daemon and drives the admin API with the exact request sequence the UI
 * performs, using the REAL pure model from packages/ui (masked-read → draft →
 * payload) so the whole wiring — model semantics, adapter-shaped PUTs, daemon
 * redaction/preservation, diagnostics, fixed-query test — is exercised
 * end-to-end. The DOM layer is covered separately by the sentinel test.
 *
 * No external network: the per-provider live test targets a loopback SearXNG
 * host, which the egress policy refuses BEFORE any connection — the honest
 * `blocked` classification the UI renders inline.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createSearchSettingsDraft,
  pendingRestartProviderIds,
  searchDraftToPayload,
} from '@/features/api-service/searchSettingsModel';
import type { SearchServerConfig } from '@/daemon/types-server';

import {
  buildDaemon,
  type Daemon,
  type DaemonPaths,
  resetDaemonSingletonsForTests,
} from '../bootstrap';
import { loadConfig } from '../config';

const KEY_SENTINEL = 'SMOKE_TAVILY_KEY_SENTINEL';

let daemon: Daemon | undefined;
let tempHome: string | undefined;
let adminBase = '';

async function bootDaemon(): Promise<void> {
  resetDaemonSingletonsForTests();
  tempHome = mkdtempSync(join(tmpdir(), 'omnicross-search-smoke-'));
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

async function adminFetch(method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: unknown }> {
  const response = await fetch(`${adminBase}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

/** The adapter's PUT shape: the model payload over the masked read. */
async function uiSaveSearch(draft: ReturnType<typeof createSearchSettingsDraft>): Promise<void> {
  const read = await adminFetch('GET', '/admin/api/server');
  const masked = (read.json as { server: { search: SearchServerConfig } }).server.search;
  // The adapter rebuilds the full segment from the last-loaded masked config;
  // the model's payload already carries the complete tree.
  const put = await adminFetch('PUT', '/admin/api/server', {
    search: searchDraftToPayload(draft),
  });
  expect(put.status).toBe(200);
}

function persistedSearch(): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(tempHome!, 'config.json'), 'utf8')) as {
    server?: { search?: Record<string, unknown> };
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

describe('search settings end-to-end smoke (task 6.2)', () => {
  it('configures a provider write-only, shows pending restart, tests it, then removes it', async () => {
    await bootDaemon();

    // ── 1. The UI builds its draft from the masked read and types a key. ──
    const initial = await adminFetch('GET', '/admin/api/server');
    expect(initial.status).toBe(200);
    const initialSearch = (initial.json as { server: { search: SearchServerConfig } }).server.search;
    const draft = createSearchSettingsDraft(initialSearch);
    draft.providers.tavily!.apiKeyInput = KEY_SENTINEL;
    draft.providers.searxng!.apiHost = 'http://127.0.0.1:9'; // egress-refused by design
    await uiSaveSearch(draft);

    // ── 2. GET never echoes the key; the store of record keeps it. ──
    const maskedRead = await adminFetch('GET', '/admin/api/server');
    expect(maskedRead.text).not.toContain(KEY_SENTINEL);
    const masked = (maskedRead.json as { server: { search: SearchServerConfig } }).server.search;
    expect(masked.providers.tavily).toEqual({ apiKeyConfigured: true });
    expect(masked.providers.searxng?.apiHost).toBe('http://127.0.0.1:9');
    const persistedProviders = persistedSearch().providers as Record<string, { apiKey?: string }>;
    expect(persistedProviders.tavily?.apiKey).toBe(KEY_SENTINEL);

    // ── 3. Diagnostics + the model's pending-restart comparison fire. ──
    const diagnosticsRead = await adminFetch('GET', '/admin/api/search/diagnostics');
    expect(diagnosticsRead.status).toBe(200);
    expect(diagnosticsRead.text).not.toContain(KEY_SENTINEL);
    const diagnostics = (diagnosticsRead.json as { diagnostics: { rows: Array<{ providerId: string; status?: string }> } }).diagnostics;
    // Runtime rows: only the keyless pair runs (tavily/searxng were saved
    // after boot); the unconfigured rows name the API providers the persisted
    // config omits (searxng IS persisted, so it has no row until restart).
    expect(diagnostics.rows.map((row) => row.providerId).sort()).toEqual([
      'http-bing', 'http-duckduckgo', 'jina', 'z.ai', 'zhipu',
    ]);
    // The REAL model comparison names the pending-restart providers → the
    // banner renders them.
    expect(pendingRestartProviderIds(masked, { ...diagnostics, rows: diagnostics.rows } as never))
      .toEqual(['tavily', 'searxng']);

    // ── 4. The fixed-query test refuses the loopback target honestly. ──
    const testRead = await adminFetch('POST', '/admin/api/search/test', { providerId: 'searxng' });
    expect(testRead.status).toBe(200);
    const diagnostic = (testRead.json as { result: { diagnostic: { status: string; reason?: string } } }).result.diagnostic;
    expect(diagnostic.status).toBe('blocked');
    expect(diagnostic.reason).toContain('egress policy');
    expect(testRead.text).not.toContain(KEY_SENTINEL);

    // ── 5. Masked round-trip edit keeps the stored key (nothing wiped). ──
    const editDraft = createSearchSettingsDraft(masked);
    editDraft.providers.searxng!.apiHost = 'http://127.0.0.1:10';
    await uiSaveSearch(editDraft);
    expect(persistedProviders.tavily?.apiKey).toBe(KEY_SENTINEL);
    expect((persistedSearch().providers as Record<string, { apiHost?: string }>).searxng?.apiHost)
      .toBe('http://127.0.0.1:10');

    // ── 6. Removal: entry gone, secret gone. ──
    const preRemove = await adminFetch('GET', '/admin/api/server');
    const removeDraft = createSearchSettingsDraft(
      (preRemove.json as { server: { search: SearchServerConfig } }).server.search,
    );
    removeDraft.providers.tavily!.removed = true;
    await uiSaveSearch(removeDraft);
    const after = (await adminFetch('GET', '/admin/api/server')).text;
    expect(after).not.toContain('apiKeyConfigured":true');
    expect(persistedSearch().providers).not.toHaveProperty('tavily');
  });
});
