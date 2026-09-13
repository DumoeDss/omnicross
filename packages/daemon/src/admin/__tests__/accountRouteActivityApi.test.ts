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

  it('filters by credentialKind so the UI can split accounts from provider keys', async () => {
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
      providerId: 'deepseek',
      credentialKind: 'provider-key',
      keyId: 'key-pool-1',
      endpoint: 'chat',
      sessionKey: 'outbound:key-pool-1',
      sessionSource: 'route-session-id',
      model: 'deepseek-v3',
      status: 200,
      durationMs: 40,
      ts: 2_000,
    });

    const run = async (query: string): Promise<unknown> => {
      const req = {
        method: 'GET',
        url: `/admin/api/accounts/route-activity${query}`,
      } as http.IncomingMessage;
      const out = response();
      await handleAdminApi(req, out.res, '/admin/api/accounts/route-activity', {} as AdminApiDeps);
      expect(out.status()).toBe(200);
      return out.json();
    };

    // Unfiltered: both kinds share the timeline.
    expect(await run('')).toMatchObject({ records: expect.arrayContaining([
      expect.objectContaining({ credentialKind: 'provider-key', keyId: 'key-pool-1' }),
      expect.objectContaining({ accountId: 'account-a', credentialKind: 'subscription-account' }),
    ]) });
    // Kind-filtered: exactly one row each way. Key ids are metadata; key
    // STRINGS never appear (they never enter the store at all).
    expect(await run('?credentialKind=provider-key')).toMatchObject({
      records: [expect.objectContaining({ providerId: 'deepseek', keyId: 'key-pool-1' })],
    });
    expect(await run('?credentialKind=subscription-account')).toMatchObject({
      records: [expect.objectContaining({ accountId: 'account-a' })],
    });
    // An unknown kind value is ignored (both rows) rather than rejected.
    expect(await run('?credentialKind=nonsense')).toMatchObject({ records: expect.arrayContaining([
      expect.objectContaining({ accountId: 'account-a' }),
      expect.objectContaining({ keyId: 'key-pool-1' }),
    ]) });
  });
});
