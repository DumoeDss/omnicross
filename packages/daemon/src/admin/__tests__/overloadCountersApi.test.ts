import type http from 'node:http';

import { getSharedOverloadCounter } from '@omnicross/core/pipeline/ServerOverloadCounter';
import { afterEach, describe, expect, it } from 'vitest';

import { handleAdminApi, type AdminApiDeps } from '../adminApi';

function response(): { res: http.ServerResponse; status: () => number; json: () => unknown } {
  let code = 0;
  let body = '';
  const res = {
    writeHead: (status: number) => {
      code = status;
    },
    end: (value?: string) => {
      body = value ?? '';
    },
  } as unknown as http.ServerResponse;
  return { res, status: () => code, json: () => JSON.parse(body) as unknown };
}

afterEach(() => getSharedOverloadCounter().clear());

describe('overload counters admin projection', () => {
  it('returns the per-account tally and honors filters', async () => {
    const store = getSharedOverloadCounter();
    // Real timestamps: the handler reads with `Date.now()`, which prunes entries
    // older than 24h — so the test must record within that window (as prod does).
    const now = Date.now();
    store.recordOverload({ providerId: 'codex', accountId: 'account-a', endpoint: 'responses' }, now);
    store.recordOverload({ providerId: 'codex', accountId: 'account-a', endpoint: 'responses' }, now);
    store.recordOverload({ providerId: 'codex', accountId: 'account-b', endpoint: 'responses' }, now);

    const req = {
      method: 'GET',
      url: '/admin/api/accounts/overload-counters?accountId=account-a',
    } as http.IncomingMessage;
    const out = response();

    await handleAdminApi(
      req,
      out.res,
      '/admin/api/accounts/overload-counters',
      {} as AdminApiDeps,
    );

    expect(out.status()).toBe(200);
    expect(out.json()).toMatchObject({
      available: true,
      entries: [{ accountId: 'account-a', count: 2 }],
    });
    // No request content is ever present — counters carry counts + timestamps only.
    expect(JSON.stringify(out.json())).not.toContain('prompt');
  });
});
