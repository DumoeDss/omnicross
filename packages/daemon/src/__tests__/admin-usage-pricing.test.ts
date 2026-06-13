/**
 * admin-usage-pricing.test.ts — the `/admin/api/usage/*` + `/admin/api/pricing/*`
 * surface (usage-pricing child): auth gate, date-range stats (totals/by-model/
 * by-api-key incl. pool-key label resolution + the unattributed group), pricing
 * CRUD round-trip, fetch-latest with a mocked pricing source (applied count +
 * userEdited conflict + upstream-failure error), stateless resolve-conflicts,
 * and the secret-egress net over every new GET payload.
 *
 * Boots the full daemon in process (mirrors `admin-pool-health.test.ts`) with
 * an admin token configured so the auth gate is actually exercised.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_LITELLM_PRICING_URL } from '@omnicross/contracts/pricing-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

const ADMIN_TOKEN = 'admin-token-SENTINEL';
const POOL_KEY_SECRET = 'sk-poolkey-SENTINEL-zzzz9999';

let tmpDir: string;
let daemon: Daemon;
let configPath: string;
let adminBase: string;

async function adminFetch(
  method: string,
  path: string,
  body?: unknown,
  opts: { auth?: boolean } = {},
): Promise<{ status: number; text: string; json: unknown }> {
  const headers: Record<string, string> = {};
  if (opts.auth !== false) headers['Authorization'] = `Bearer ${ADMIN_TOKEN}`;
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

/** Insert one usage event through the awaitable recorder path. */
async function seedEvent(over: { apiKeyId?: string | null; sessionId?: string | null; model?: string } = {}): Promise<void> {
  await daemon.usageRecorder.recordAsync({
    providerId: 'mock',
    model: over.model ?? 'mock-model',
    apiKeyId: over.apiKeyId ?? null,
    sessionId: over.sessionId ?? null,
    engineOrigin: 'completion',
    usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 },
  });
}

const WIDE = () => `startTs=0&endTs=${Date.now() + 60_000}`;

beforeEach(async () => {
  resetDaemonSingletonsForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-usage-admin-'));
  configPath = join(tmpDir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        providers: [
          {
            id: 'mock',
            apiFormat: 'openai',
            baseUrl: 'http://127.0.0.1:1/v1', // never dialed in this suite
            apiKey: '',
            apiKeys: [{ id: 'k1', apiKey: POOL_KEY_SECRET, label: 'Primary Key' }],
            models: ['mock-model'],
          },
        ],
        server: { enabled: false, networkBinding: false, port: 0, endpoints: [] },
        admin: { port: 0, token: ADMIN_TOKEN },
      },
      null,
      2,
    ),
    'utf8',
  );

  const config = loadConfig(configPath);
  daemon = buildDaemon(config, {
    configPath,
    keysPath: join(tmpDir, 'keys.json'),
    tokensPath: join(tmpDir, 'tokens.json'),
    masterKeyFilePath: join(tmpDir, 'master.key'),
  });
  await daemon.llmConfig.ready();
  await daemon.adminServer.start();
  adminBase = daemon.adminServer.getStatus().url as string;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (daemon) {
    await daemon.adminServer.stop();
    daemon.apiKeyPool.dispose();
  }
  resetDaemonSingletonsForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('auth gate', () => {
  it('rejects every new route without the admin token', async () => {
    for (const [method, path] of [
      ['GET', `/admin/api/usage/totals?${WIDE()}`],
      ['GET', '/admin/api/pricing'],
      ['POST', '/admin/api/pricing/fetch-latest'],
    ] as const) {
      const r = await adminFetch(method, path, undefined, { auth: false });
      expect(r.status).toBe(401);
    }
  });
});

// ── Usage stats ───────────────────────────────────────────────────────────────

describe('GET /admin/api/usage/*', () => {
  it('totals aggregates seeded events over the range', async () => {
    await seedEvent();
    await seedEvent();
    const r = await adminFetch('GET', `/admin/api/usage/totals?${WIDE()}`);
    expect(r.status).toBe(200);
    const totals = r.json as { eventCount: number; inputTokens: number; outputTokens: number };
    expect(totals.eventCount).toBe(2);
    expect(totals.inputTokens).toBe(20);
    expect(totals.outputTokens).toBe(40);
  });

  it('400s a missing or non-numeric range param', async () => {
    for (const qs of ['', 'startTs=0', `startTs=abc&endTs=${Date.now()}`, 'startTs=1.5&endTs=2']) {
      const r = await adminFetch('GET', `/admin/api/usage/totals${qs ? `?${qs}` : ''}`);
      expect(r.status).toBe(400);
    }
  });

  it('by-model groups and flags unpriced models', async () => {
    await seedEvent();
    await seedEvent({ model: 'other-model' });
    const r = await adminFetch('GET', `/admin/api/usage/by-model?${WIDE()}`);
    expect(r.status).toBe(200);
    const rows = r.json as Array<{ model: string; eventCount: number; unpriced: boolean }>;
    expect(rows).toHaveLength(2);
    // No pricing rows exist yet → everything reads unpriced.
    expect(rows.every((row) => row.unpriced)).toBe(true);
  });

  it('by-api-key resolves pool-key labels and the unattributed group', async () => {
    await seedEvent({ apiKeyId: 'k1' });
    await seedEvent({ apiKeyId: 'unknown-key' });
    await seedEvent({ apiKeyId: null });
    const r = await adminFetch('GET', `/admin/api/usage/by-api-key?${WIDE()}`);
    expect(r.status).toBe(200);
    const rows = r.json as Array<{ apiKeyId: string | null; label: string; providerId: string | null }>;
    expect(rows).toHaveLength(3);
    const known = rows.find((row) => row.apiKeyId === 'k1')!;
    const unknown = rows.find((row) => row.apiKeyId === 'unknown-key')!;
    const unattributed = rows.find((row) => row.apiKeyId === null)!;
    expect(known.label).toBe('Primary Key'); // resolved from the pool key's label
    expect(known.providerId).toBe('mock');
    expect(unknown.label).toBe('unknown-key'); // unknown id keeps the raw id
    expect(unattributed.label).toBe('unattributed');
    expect(unattributed.providerId).toBeNull();
    // SECRET-EGRESS: label resolution never leaks the pool key value.
    expect(r.text).not.toContain(POOL_KEY_SECRET);
  });
});

// ── Pricing CRUD ──────────────────────────────────────────────────────────────

const ENTRY = {
  providerId: 'mock',
  modelId: 'mock-model',
  inputPricePer1m: 3,
  outputPricePer1m: 15,
  cacheReadPricePer1m: 0.3,
};

describe('pricing CRUD', () => {
  it('PUT upserts with source user and GET lists it', async () => {
    const put = await adminFetch('PUT', '/admin/api/pricing', ENTRY);
    expect(put.status).toBe(200);
    const entry = (put.json as { entry: { source: string; userEdited: boolean } }).entry;
    expect(entry.source).toBe('user');
    expect(entry.userEdited).toBe(true);

    const get = await adminFetch('GET', '/admin/api/pricing');
    expect(get.status).toBe(200);
    const entries = (get.json as { entries: Array<{ modelId: string }> }).entries;
    expect(entries.map((e) => e.modelId)).toEqual(['mock-model']);
  });

  it('400s an invalid PUT body and persists nothing', async () => {
    for (const bad of [
      {},
      { ...ENTRY, providerId: '' },
      { ...ENTRY, inputPricePer1m: 'three' },
      { ...ENTRY, outputPricePer1m: Number.NaN },
      // PRESENT-but-non-numeric optional cache prices must 400, not coerce to null.
      { ...ENTRY, cacheReadPricePer1m: '0.3' },
      // (Infinity/NaN can't travel over JSON — they serialize to null, which is
      // a LEGAL present-null. Use a JSON-surviving non-numeric instead.)
      { ...ENTRY, cacheWritePricePer1m: true },
    ]) {
      const r = await adminFetch('PUT', '/admin/api/pricing', bad);
      expect(r.status).toBe(400);
    }
    const get = await adminFetch('GET', '/admin/api/pricing');
    expect((get.json as { entries: unknown[] }).entries).toEqual([]);
  });

  it('DELETE removes the row and a later GET no longer lists it', async () => {
    await adminFetch('PUT', '/admin/api/pricing', ENTRY);
    const del = await adminFetch('DELETE', '/admin/api/pricing?providerId=mock&modelId=mock-model');
    expect(del.status).toBe(200);
    expect((del.json as { deleted: boolean }).deleted).toBe(true);

    const get = await adminFetch('GET', '/admin/api/pricing');
    expect((get.json as { entries: unknown[] }).entries).toEqual([]);

    const again = await adminFetch('DELETE', '/admin/api/pricing?providerId=mock&modelId=mock-model');
    expect((again.json as { deleted: boolean }).deleted).toBe(false);
  });

  it('400s a DELETE missing providerId/modelId', async () => {
    const r = await adminFetch('DELETE', '/admin/api/pricing?providerId=mock');
    expect(r.status).toBe(400);
  });
});

// ── Source refresh + stateless conflict resolution ────────────────────────────

/** Stub global fetch SELECTIVELY: the LiteLLM URL → the given impl; everything
 *  else (the admin test client itself) passes through to the real fetch. */
function stubPricingSource(impl: () => Promise<Response>): void {
  const realFetch = fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === DEFAULT_LITELLM_PRICING_URL) return impl();
    return realFetch(input, init);
  });
}

const LITELLM_BODY = {
  'mock-model': {
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000002,
    litellm_provider: 'mock',
  },
  'fresh-model': {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000004,
    litellm_provider: 'mock',
  },
};

describe('POST /admin/api/pricing/fetch-latest + resolve-conflicts', () => {
  it('applies non-conflicting rows (count) and reports userEdited conflicts in full', async () => {
    await adminFetch('PUT', '/admin/api/pricing', ENTRY); // userEdited local row
    stubPricingSource(async () => new Response(JSON.stringify(LITELLM_BODY), { status: 200 }));

    const r = await adminFetch('POST', '/admin/api/pricing/fetch-latest');
    expect(r.status).toBe(200);
    const body = r.json as {
      appliedCount: number;
      conflicts: Array<{ modelId: string; current: { inputPricePer1m: number }; incoming: { inputPricePer1m: number } }>;
      fetchedAt: number;
      sourceUrl: string;
    };
    expect(body.appliedCount).toBe(1); // fresh-model only
    expect(body.sourceUrl).toBe(DEFAULT_LITELLM_PRICING_URL);
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0].modelId).toBe('mock-model');
    expect(body.conflicts[0].current.inputPricePer1m).toBe(3); // unchanged
    expect(body.conflicts[0].incoming.inputPricePer1m).toBe(1);

    // The user-edited row was NOT applied; the fresh row was.
    const get = await adminFetch('GET', '/admin/api/pricing');
    const entries = (get.json as { entries: Array<{ modelId: string; inputPricePer1m: number; userEdited: boolean }> }).entries;
    expect(entries.find((e) => e.modelId === 'mock-model')!.inputPricePer1m).toBe(3);
    expect(entries.find((e) => e.modelId === 'fresh-model')!.inputPricePer1m).toBe(3);
  });

  it('surfaces an upstream failure as an error response with the table unchanged', async () => {
    await adminFetch('PUT', '/admin/api/pricing', ENTRY);
    stubPricingSource(async () => new Response('oops', { status: 503 }));

    const r = await adminFetch('POST', '/admin/api/pricing/fetch-latest');
    expect(r.status).toBe(502);
    expect((r.json as { error: { message: string } }).error.message).toContain('fetch failed');

    const get = await adminFetch('GET', '/admin/api/pricing');
    const entries = (get.json as { entries: Array<{ inputPricePer1m: number }> }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].inputPricePer1m).toBe(3);
  });

  it('resolves conflicts STATELESSLY from echoed incoming entries (overwrite + skip)', async () => {
    // Two user-edited rows that will both conflict on refresh.
    await adminFetch('PUT', '/admin/api/pricing', ENTRY);
    await adminFetch('PUT', '/admin/api/pricing', { ...ENTRY, modelId: 'fresh-model', inputPricePer1m: 77 });
    stubPricingSource(async () => new Response(JSON.stringify(LITELLM_BODY), { status: 200 }));
    const fetchRes = await adminFetch('POST', '/admin/api/pricing/fetch-latest');
    const conflicts = (fetchRes.json as { conflicts: Array<{ providerId: string; modelId: string; incoming: unknown }> }).conflicts;
    expect(conflicts).toHaveLength(2);

    // No server-side state: the client sends explicit row ids + echoes each
    // incoming back with a decision.
    const r = await adminFetch('POST', '/admin/api/pricing/resolve-conflicts', {
      resolutions: [
        { providerId: 'mock', modelId: 'mock-model', action: 'overwrite', incoming: conflicts.find((c) => c.modelId === 'mock-model')!.incoming },
        { providerId: 'mock', modelId: 'fresh-model', action: 'skip', incoming: conflicts.find((c) => c.modelId === 'fresh-model')!.incoming },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ overwrittenCount: 1, skippedCount: 1, staleCount: 0 });

    const get = await adminFetch('GET', '/admin/api/pricing');
    const entries = (get.json as { entries: Array<{ modelId: string; inputPricePer1m: number; userEdited: boolean }> }).entries;
    const overwritten = entries.find((e) => e.modelId === 'mock-model')!;
    const skipped = entries.find((e) => e.modelId === 'fresh-model')!;
    expect(overwritten.inputPricePer1m).toBe(1); // incoming applied
    expect(overwritten.userEdited).toBe(false); // user-edit mark cleared
    expect(skipped.inputPricePer1m).toBe(77); // untouched
    expect(skipped.userEdited).toBe(true);
  });

  it('400s malformed resolution bodies', async () => {
    for (const bad of [
      {},
      { resolutions: [{ providerId: 'mock', modelId: 'mock-model', action: 'overwrite' }] }, // missing incoming
      { resolutions: [{ providerId: 'mock', modelId: 'mock-model', action: 'maybe', incoming: ENTRY }] }, // bad action
      { resolutions: [{ action: 'overwrite', incoming: ENTRY }] }, // missing top-level ids
      // top-level ids that do NOT match the echoed incoming (miswired client)
      { resolutions: [{ providerId: 'mock', modelId: 'some-other-model', action: 'overwrite', incoming: ENTRY }] },
    ]) {
      const r = await adminFetch('POST', '/admin/api/pricing/resolve-conflicts', bad);
      expect(r.status).toBe(400);
    }
  });

  it('rejects an overwrite targeting a row that is not currently a userEdited conflict (stale, per-row)', async () => {
    // ONE genuine user-edited conflict; the other target does not exist at all.
    await adminFetch('PUT', '/admin/api/pricing', ENTRY);
    const ghost = { ...ENTRY, modelId: 'ghost-model', inputPricePer1m: 5 };
    const r = await adminFetch('POST', '/admin/api/pricing/resolve-conflicts', {
      resolutions: [
        { providerId: 'mock', modelId: 'mock-model', action: 'overwrite', incoming: { ...ENTRY, inputPricePer1m: 1 } },
        { providerId: 'mock', modelId: 'ghost-model', action: 'overwrite', incoming: ghost }, // stale
      ],
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ overwrittenCount: 1, skippedCount: 0, staleCount: 1 });

    // The stale overwrite created/overwrote NOTHING; the genuine one applied.
    const get = await adminFetch('GET', '/admin/api/pricing');
    const entries = (get.json as { entries: Array<{ modelId: string; inputPricePer1m: number }> }).entries;
    expect(entries.map((e) => e.modelId)).toEqual(['mock-model']);
    expect(entries[0].inputPricePer1m).toBe(1);
  });
});

// ── Secret-egress net ─────────────────────────────────────────────────────────

describe('secret egress', () => {
  it('no new GET payload carries the pool key secret', async () => {
    await seedEvent({ apiKeyId: 'k1' });
    await adminFetch('PUT', '/admin/api/pricing', ENTRY);
    for (const path of [
      `/admin/api/usage/totals?${WIDE()}`,
      `/admin/api/usage/by-model?${WIDE()}`,
      `/admin/api/usage/by-api-key?${WIDE()}`,
      '/admin/api/pricing',
    ]) {
      const r = await adminFetch('GET', path);
      expect(r.status).toBe(200);
      expect(r.text).not.toContain(POOL_KEY_SECRET);
      expect(r.text).not.toContain(ADMIN_TOKEN);
    }
  });
});
