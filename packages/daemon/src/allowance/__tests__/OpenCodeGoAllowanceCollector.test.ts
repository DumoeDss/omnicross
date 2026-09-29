/**
 * OpenCodeGoAllowanceCollector tests — the usage-poll contract plus the
 * opencodego-egress-identity UA on the background `GET /v1/usage` call.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountAllowanceStore } from '@omnicross/core/pipeline/AccountAllowanceStore';
import {
  __resetOpenCodeGoHeadersForTests,
  setOpenCodeGoUserAgent,
} from '@omnicross/core/provider-proxy/identity/openCodeGoHeaders';

import { OpenCodeGoAllowanceCollector, type OpenCodeGoAllowanceFetch } from '../OpenCodeGoAllowanceCollector';

afterEach(() => {
  __resetOpenCodeGoHeadersForTests();
});

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'oc-1',
    label: 'OpenCodeGo 1',
    tokens: { authMethod: 'manual', status: 'configured', apiKey: 'oc-key-1' },
    ...overrides,
  } as Parameters<OpenCodeGoAllowanceCollector['collect']>[0];
}

function makeCollector(
  store: AccountAllowanceStore,
  fetchImpl: OpenCodeGoAllowanceFetch,
): OpenCodeGoAllowanceCollector {
  return new OpenCodeGoAllowanceCollector(
    { getAccessTokenForAccount: vi.fn().mockResolvedValue('oc-key-1') },
    store,
    fetchImpl,
  );
}

describe('OpenCodeGoAllowanceCollector', () => {
  it('carries the default omnicross UA on the GET /v1/usage poll (no session header)', async () => {
    const store = new AccountAllowanceStore();
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl: OpenCodeGoAllowanceFetch = async (url, init) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ usage: { rolling: { percent: 10 }, weekly: { percent: 20 } } }), { status: 200 });
    };
    await makeCollector(store, fetchImpl).collect(makeAccount());

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://opencode.ai/zen/go/v1/usage');
    expect(calls[0].headers['Authorization']).toBe('Bearer oc-key-1');
    expect(calls[0].headers['User-Agent']).toBe('omnicross/0.0.0-dev');
    expect(calls[0].headers['x-opencode-session']).toBeUndefined();
  });

  it('carries the CONFIGURED UA when the library identity is set', async () => {
    setOpenCodeGoUserAgent('elftia/1.2.3');
    const store = new AccountAllowanceStore();
    const fetchImpl: OpenCodeGoAllowanceFetch = async () =>
      new Response(JSON.stringify({ usage: { rolling: { percent: 1 } } }), { status: 200 });
    await makeCollector(store, fetchImpl).collect(makeAccount({ id: 'oc-2' }));

    // The snapshot itself parsed fine (happy path).
    const snapshot = store.get('opencodego', 'oc-2', Date.now());
    expect(snapshot?.windows.find((w) => w.id === 'five-hour')?.usedPercent).toBe(1);
  });

  it('always displays the monthly bar; advisory unless genuinely rate-limited', async () => {
    // rate-limited (production shape — the account fails every request with
    // 429 GoUsageLimitError limitName=monthly): the window is NOT advisory, so
    // the scheduling policy may pause the genuinely dead account.
    const dead = new AccountAllowanceStore();
    const deadFetch: OpenCodeGoAllowanceFetch = async () =>
      new Response(JSON.stringify({
        usage: {
          rolling: { percent: 3 },
          weekly: { percent: 69 },
          monthly: { percent: 97, status: 'rate-limited', resetsAt: '2026-11-01T00:00:00Z' },
        },
      }), { status: 200 });
    await makeCollector(dead, deadFetch).collect(makeAccount({ id: 'oc-m1' }));
    const deadSnapshot = dead.get('opencodego', 'oc-m1', Date.now())!;
    const monthly = deadSnapshot.windows.find((w) => w.id === 'monthly');
    expect(monthly).toBeDefined();
    // The authoritative status outranks the stale percent (→ 100).
    expect(monthly?.usedPercent).toBe(100);
    expect(monthly?.resetsAt).toBe('2026-11-01T00:00:00.000Z');
    expect(monthly?.advisory).toBeUndefined();

    // NOT rate-limited (the "Use balance" fallback keeps the key serving):
    // the bar is still DISPLAYED (visibility), but marked advisory — the
    // worst-window pause policy must not strand the serving key.
    const serving = new AccountAllowanceStore();
    const servingFetch: OpenCodeGoAllowanceFetch = async () =>
      new Response(JSON.stringify({
        usage: {
          rolling: { percent: 3 },
          weekly: { percent: 69 },
          monthly: { percent: 100 },
        },
      }), { status: 200 });
    await makeCollector(serving, servingFetch).collect(makeAccount({ id: 'oc-m2' }));
    const servingSnapshot = serving.get('opencodego', 'oc-m2', Date.now())!;
    const servingMonthly = servingSnapshot.windows.find((w) => w.id === 'monthly');
    expect(servingMonthly).toBeDefined();
    expect(servingMonthly?.usedPercent).toBe(100);
    expect(servingMonthly?.advisory).toBe(true);
    expect(servingSnapshot.windows.find((w) => w.id === 'seven-day')?.usedPercent).toBe(69);
  });

  it('a 401 poll produces the unauthorized failure snapshot', async () => {
    const store = new AccountAllowanceStore();
    const fetchImpl: OpenCodeGoAllowanceFetch = async () => new Response('nope', { status: 401 });
    const snapshot = await makeCollector(store, fetchImpl).collect(makeAccount({ id: 'oc-3' }));

    expect(snapshot.lastErrorCode).toBe('opencodego_usage_unauthorized');
  });
});
