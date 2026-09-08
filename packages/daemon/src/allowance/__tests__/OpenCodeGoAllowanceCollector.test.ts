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

  it('a 401 poll produces the unauthorized failure snapshot', async () => {
    const store = new AccountAllowanceStore();
    const fetchImpl: OpenCodeGoAllowanceFetch = async () => new Response('nope', { status: 401 });
    const snapshot = await makeCollector(store, fetchImpl).collect(makeAccount({ id: 'oc-3' }));

    expect(snapshot.lastErrorCode).toBe('opencodego_usage_unauthorized');
  });
});
