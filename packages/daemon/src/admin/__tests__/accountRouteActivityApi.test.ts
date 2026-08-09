import type http from 'node:http';

import { getSharedAccountRouteActivity } from '@omnicross/core/pipeline/AccountRouteActivity';
import { afterEach, describe, expect, it } from 'vitest';

import { handleAdminApi, type AdminApiDeps } from '../adminApi';

function response(): { res: http.ServerResponse; status: () => number; json: () => unknown } {
  let code = 0;
  let body = '';
  const res = {
    writeHead: (status: number) => { code = status; },
    end: (value?: string) => { body = value ?? ''; },
  } as unknown as http.ServerResponse;
  return { res, status: () => code, json: () => JSON.parse(body) as unknown };
}

afterEach(() => getSharedAccountRouteActivity().clear());

describe('account route activity admin projection', () => {
  it('returns bounded metadata and honors account filters', async () => {
    const store = getSharedAccountRouteActivity();
    store.record({
      providerId: 'codex',
      accountId: 'account-a',
      endpoint: 'responses',
      sessionKey: 'abc12345',
      sessionSource: 'session-header',
      model: 'gpt-5-codex',
      status: 200,
      durationMs: 20,
      ts: 1_000,
    });
    store.record({
      providerId: 'codex',
      accountId: 'account-b',
      endpoint: 'responses',
      sessionKey: 'def67890',
      sessionSource: 'session-header',
      model: 'gpt-5-codex',
      status: 429,
      durationMs: 30,
      ts: 2_000,
    });
    const req = {
      method: 'GET',
      url: '/admin/api/accounts/route-activity?accountId=account-b&limit=1',
    } as http.IncomingMessage;
    const out = response();

    await handleAdminApi(
      req,
      out.res,
      '/admin/api/accounts/route-activity',
      {} as AdminApiDeps,
    );

    expect(out.status()).toBe(200);
    expect(out.json()).toMatchObject({
      available: true,
      capacity: 300,
      records: [{ accountId: 'account-b', status: 429 }],
    });
    expect(JSON.stringify(out.json())).not.toContain('prompt');
  });
});
