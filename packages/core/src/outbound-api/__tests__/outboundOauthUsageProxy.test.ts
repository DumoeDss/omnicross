/**
 * Tests for the `GET /api/oauth/usage` outbound proxy (R9 /
 * claude-api-experience-extras): pure-cache wire-shape rendering, zero
 * upstream/refresh (AC-13), binding gating, Anthropic-shaped error paths via
 * the gated mark, sanitization, and the config-off byte-identity pin.
 *
 * @module outbound-api/__tests__/outboundOauthUsageProxy.test
 */
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AccountAllowanceSnapshot } from '@omnicross/contracts/account-allowance-types';

import { getSharedAccountAllowanceStore } from '../../pipeline/AccountAllowanceStore';
import { ProviderProxyRouteMap } from '../../provider-proxy/providerProxyRouteMap';
import {
  handleOutboundRequest,
  isAnthropicOauthUsagePath,
} from '../outboundApiRouter';
import { OutboundConcurrencyGate } from '../outboundConcurrencyGate';
import { OutboundRateLimiter } from '../outboundRateLimiter';
import type { GatewayBinding, OutboundApiDeps, OutboundKeyDb, OutboundKeyDbRow } from '../types';
import { UserMessageSerialQueue } from '../userMessageSerialQueue';

function makeReq(opts: { method?: string; url?: string; headers?: Record<string, string> }): http.IncomingMessage {
  const r = Readable.from([]) as unknown as http.IncomingMessage;
  r.method = opts.method ?? 'GET';
  r.url = opts.url ?? '/api/oauth/usage';
  r.headers = opts.headers ?? { authorization: 'Bearer any' };
  r.httpVersion = '1.1';
  (r as unknown as { socket: unknown }).socket = { remoteAddress: '127.0.0.1', destroy: () => {} };
  return r;
}

class MockRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  headersSent = false;
  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.statusCode = status;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
    return this;
  }
  end(chunk?: string): this {
    if (chunk) this.body += chunk;
    return this;
  }
}

const enabledRow: OutboundKeyDbRow = {
  id: 'oak_1',
  name: 'k',
  keyHash: '',
  keyPrefix: 'sk-omnicross-',
  enabled: true,
  createdAt: Date.now(),
  lastUsedAt: null,
  revokedAt: null,
};

function mkDeps(): OutboundApiDeps {
  const db: OutboundKeyDb = {
    outboundApiKeysList: async () => [],
    outboundApiKeysGetByHash: async () => enabledRow,
    outboundApiKeysCreate: async () => enabledRow,
    outboundApiKeysRevoke: async () => true,
    outboundApiKeysTouchLastUsed: async () => true,
    outboundApiKeysSetEnabled: async () => true,
    outboundApiKeysSetMaxConcurrency: async () => true,
    outboundApiKeysSetPolicy: async () => true,
    outboundApiKeysMarkActivated: async () => true,
    outboundApiKeysReveal: async () => null,
    outboundApiKeysDelete: async () => true,
  };
  const provider = { id: 'claude', name: 'Claude', models: ['claude-x'], enabled: true };
  return {
    db,
    llmConfig: { getProvider: async () => provider } as unknown as OutboundApiDeps['llmConfig'],
    providerProxy: { getRouteMap: () => new ProviderProxyRouteMap() } as unknown as OutboundApiDeps['providerProxy'],
    proxyDeps: { llmConfig: { getProvider: async () => provider }, apiKeyPool: null } as unknown,
  } as unknown as OutboundApiDeps;
}

/** A messages binding to the Claude subscription pool (account-bound variant optional). */
function claudeBinding(over: Partial<GatewayBinding> = {}): GatewayBinding {
  return {
    id: 'b-claude',
    name: 'claude route',
    enabled: true,
    endpoint: 'messages',
    target: { kind: 'account-pool', providerId: 'claude' },
    fallback: 'fail',
    ...over,
  };
}

const CONFIG_ON = { endpoints: [], bindings: [claudeBinding()], anthropic: { proxyOauthUsage: true } };
const CONFIG_OFF = { endpoints: [], bindings: [claudeBinding()] };

function snapshot(accountId: string, usedPercent: number | null, state: 'fresh' | 'unavailable' = 'fresh'): AccountAllowanceSnapshot {
  return {
    providerId: 'claude',
    accountId,
    source: 'oauth-usage-api',
    observedAt: new Date().toISOString(),
    windows: [
      { id: 'five-hour', label: '5h', scope: 'all', usedPercent, resetsAt: '2026-08-29T12:00:00.000Z', state },
      { id: 'seven-day', label: '7d', scope: 'all', usedPercent: 42, resetsAt: '2026-09-01T00:00:00.000Z', state },
      { id: 'seven-day-sonnet', label: '7d sonnet', scope: 'model-family', modelFamily: 'sonnet', usedPercent: 7, resetsAt: '2026-09-01T00:00:00.000Z', state },
    ],
  };
}

async function callUsage(opts: {
  url?: string;
  headers?: Record<string, string>;
  bindings?: GatewayBinding[];
  config?: Record<string, unknown>;
  row?: OutboundKeyDbRow;
}): Promise<MockRes> {
  const res = new MockRes();
  const req = makeReq({ url: opts.url ?? '/api/oauth/usage', headers: opts.headers });
  await handleOutboundRequest(
    req,
    res as unknown as http.ServerResponse,
    mkDeps(),
    {
      endpoints: [],
      bindings: opts.bindings ?? [claudeBinding()],
      ...(opts.config ?? { anthropic: { proxyOauthUsage: true } }),
    },
    new OutboundRateLimiter(),
    new UserMessageSerialQueue(),
    new OutboundConcurrencyGate(),
  );
  return res;
}

describe('isAnthropicOauthUsagePath', () => {
  it('matches the exact path with query/trailing-slash tolerance only', () => {
    expect(isAnthropicOauthUsagePath('/api/oauth/usage')).toBe(true);
    expect(isAnthropicOauthUsagePath('/api/oauth/usage?beta=true')).toBe(true);
    expect(isAnthropicOauthUsagePath('/api/oauth/usage/')).toBe(true);
    expect(isAnthropicOauthUsagePath('/api/oauth/usagefoo')).toBe(false);
    expect(isAnthropicOauthUsagePath('/v1/messages')).toBe(false);
  });
});

describe('GET /api/oauth/usage proxy (R9)', () => {
  const store = getSharedAccountAllowanceStore();
  const accountIds: string[] = [];

  function seed(snap: AccountAllowanceSnapshot): string {
    store.set(snap);
    accountIds.push(snap.accountId);
    return snap.accountId;
  }

  afterEach(() => {
    for (const id of accountIds.splice(0)) store.delete('claude', id);
  });

  beforeEach(() => {
    accountIds.splice(0);
  });

  it('renders the api.anthropic.com wire shape from the pure cache (AC-13: zero upstream, no refresh)', async () => {
    seed(snapshot('acct-usage-1', 64));
    const res = await callUsage({});
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body) as Record<string, unknown>;
    // Sanitized: EXACTLY the three wire windows with exactly two fields each.
    expect(Object.keys(json).sort()).toEqual(['five_hour', 'seven_day', 'seven_day_sonnet']);
    for (const window of Object.values(json)) {
      expect(Object.keys(window as object).sort()).toEqual(['resets_at', 'utilization']);
    }
    expect(json['five_hour']).toEqual({ utilization: 64, resets_at: '2026-08-29T12:00:00.000Z' });
    expect(json['seven_day']).toEqual({ utilization: 42, resets_at: '2026-09-01T00:00:00.000Z' });
    expect(json['seven_day_sonnet']).toEqual({ utilization: 7, resets_at: '2026-09-01T00:00:00.000Z' });
    // No account ids anywhere.
    expect(res.body).not.toContain('acct-usage-1');
  });

  it('cold cache → null windows, and the read triggers NO collection (no store mutation)', async () => {
    const res = await callUsage({});
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      five_hour: { utilization: null, resets_at: null },
      seven_day: { utilization: null, resets_at: null },
      seven_day_sonnet: { utilization: null, resets_at: null },
    });
  });

  it('an unavailable window renders utilization:null even when other windows are fresh', async () => {
    seed(snapshot('acct-usage-2', 10, 'unavailable'));
    const res = await callUsage({});
    const json = JSON.parse(res.body) as { five_hour: { utilization: number | null } };
    expect(json.five_hour.utilization).toBeNull();
  });

  it('a STALE window (expired projection) renders utilization AND resets_at null (fresh-only truth, review D-M1)', async () => {
    // Seed a fresh snapshot whose expiresAt is already in the past — the
    // store's projection flips its windows to 'stale' on read.
    const snap = snapshot('acct-usage-stale', 64);
    snap.expiresAt = new Date(Date.now() - 60_000).toISOString();
    seed(snap);
    const res = await callUsage({});
    const json = JSON.parse(res.body) as {
      five_hour: { utilization: number | null; resets_at: string | null };
    };
    expect(json.five_hour).toEqual({ utilization: null, resets_at: null });
  });

  it('a failure snapshot (all windows unavailable) renders all-null', async () => {
    seed(snapshot('acct-usage-fail', null, 'unavailable'));
    const res = await callUsage({});
    const json = JSON.parse(res.body) as Record<string, { utilization: number | null }>;
    for (const window of Object.values(json)) expect(window.utilization).toBeNull();
  });

  it('the binding preferred account wins over other snapshots', async () => {
    seed(snapshot('acct-other', 1));
    seed(snapshot('acct-preferred', 99));
    const res = await callUsage({
      bindings: [claudeBinding({ target: { kind: 'account', providerId: 'claude', accountId: 'acct-preferred' } })],
    });
    expect(JSON.parse(res.body).five_hour.utilization).toBe(99);
  });

  it('unbound key → Anthropic 404 not_found_error', async () => {
    const res = await callUsage({ bindings: [] });
    expect(res.statusCode).toBe(404);
    const json = JSON.parse(res.body) as { type: string; error: { type: string } };
    expect(json.type).toBe('error');
    expect(json.error.type).toBe('not_found_error');
  });

  it('invalid key → Anthropic 401 authentication_error (the gated mark shapes it)', async () => {
    const res = new MockRes();
    const req = makeReq({ headers: {} });
    const deps = mkDeps();
    (deps as { db: OutboundKeyDb }).db = {
      ...deps.db,
      outboundApiKeysGetByHash: async () => null,
    } as OutboundKeyDb;
    await handleOutboundRequest(
      req,
      res as unknown as http.ServerResponse,
      deps,
      { endpoints: [], bindings: [claudeBinding()], anthropic: { proxyOauthUsage: true } },
      new OutboundRateLimiter(),
      new UserMessageSerialQueue(),
      new OutboundConcurrencyGate(),
    );
    expect(res.statusCode).toBe(401);
    expect((JSON.parse(res.body) as { error: { type: string } }).error.type).toBe('authentication_error');
  });

  it('config OFF → the path keeps its current generic behavior (no mark, generic 404)', async () => {
    const res = await callUsage({ config: {} });
    expect(res.statusCode).toBe(404);
    expect((JSON.parse(res.body) as { error: { type: string } }).error.type).toBe('outbound_api_error');
  });

  it('the anthropic-beta header presence does not change the response', async () => {
    seed(snapshot('acct-beta', 33));
    const without = await callUsage({});
    const withBeta = await callUsage({ headers: { authorization: 'Bearer any', 'anthropic-beta': 'oauth-2025-04-20' } });
    expect(withBeta.statusCode).toBe(200);
    expect(withBeta.body).toBe(without.body);
  });

  it('POST to the path is not handled by the proxy (marked Anthropic 404)', async () => {
    const post = new MockRes();
    const req = makeReq({ method: 'POST', headers: { authorization: 'Bearer any' } });
    await handleOutboundRequest(
      req,
      post as unknown as http.ServerResponse,
      mkDeps(),
      { endpoints: [], bindings: [claudeBinding()], anthropic: { proxyOauthUsage: true } },
      new OutboundRateLimiter(),
      new UserMessageSerialQueue(),
      new OutboundConcurrencyGate(),
    );
    // POST is not the usage route's method → marked 404 (Anthropic shape, since gated on).
    expect(post.statusCode).toBe(404);
    expect((JSON.parse(post.body) as { error: { type: string } }).error.type).toBe('not_found_error');
  });
});
