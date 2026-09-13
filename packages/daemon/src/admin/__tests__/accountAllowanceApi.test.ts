import { EventEmitter } from 'node:events';
import type http from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import {
  type AccountAllowanceAdminReader,
  handleAccountAllowanceApi,
} from '../accountAllowanceApi';

function request(url: string, body?: unknown): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.url = url;
  if (body !== undefined) {
    queueMicrotask(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  }
  return req;
}

function response(): {
  res: http.ServerResponse;
  status: () => number;
  json: () => unknown;
} {
  let code = 0;
  let text = '';
  const res = {
    writeHead: vi.fn((status: number) => {
      code = status;
    }),
    end: vi.fn((body?: string) => {
      text = body ?? '';
    }),
  } as unknown as http.ServerResponse;
  return {
    res,
    status: () => code,
    json: () => text ? JSON.parse(text) as unknown : null,
  };
}

const refreshCodexFn = vi.fn(async (accountId?: string) => [{
  providerId: 'codex' as const,
  accountId: accountId ?? 'a',
  source: 'oauth-usage-api' as const,
  observedAt: '2026-08-03T00:00:00.000Z',
  windows: [],
}]);

function service(overrides: Partial<AccountAllowanceAdminReader> = {}): AccountAllowanceAdminReader {
  return {
    list: vi.fn(async (filter) => [{
      providerId: filter?.providerId ?? 'codex',
      accountId: filter?.accountId ?? 'a',
      source: 'response-headers',
      observedAt: '2026-08-03T00:00:00.000Z',
      windows: [],
    }]),
    refreshClaude: vi.fn(async (accountId) => accountId === 'missing' ? [] : [{
      providerId: 'claude',
      accountId: accountId ?? 'a',
      source: 'oauth-usage-api',
      observedAt: '2026-08-03T00:00:00.000Z',
      windows: [],
    }]),
    ...overrides,
  };
}

describe('account allowance admin API', () => {
  it('reads one account through the secret-free service facade', async () => {
    const api = service();
    const out = response();
    await handleAccountAllowanceApi(
      request('/admin/api/accounts/allowances/claude/account-1'),
      out.res,
      'GET',
      ['claude', 'account-1'],
      api,
    );

    expect(api.list).toHaveBeenCalledWith({ providerId: 'claude', accountId: 'account-1' });
    expect(out.status()).toBe(200);
    expect(out.json()).toMatchObject({
      allowances: [{ providerId: 'claude', accountId: 'account-1' }],
    });
  });

  it('explicitly refreshes Claude and returns 404 for an unknown account', async () => {
    const api = service();
    const out = response();
    await handleAccountAllowanceApi(
      request('/admin/api/accounts/allowances/refresh', { accountId: 'missing' }),
      out.res,
      'POST',
      ['refresh'],
      api,
    );
    expect(api.refreshClaude).toHaveBeenCalledWith('missing');
    expect(out.status()).toBe(404);
  });

  it('routes a Codex refresh to the active /wham/usage poll when available', async () => {
    const api = service({ refreshCodex: refreshCodexFn });
    const out = response();
    await handleAccountAllowanceApi(
      request('/admin/api/accounts/allowances/refresh', { providerId: 'codex' }),
      out.res,
      'POST',
      ['refresh'],
      api,
    );
    expect(refreshCodexFn).toHaveBeenCalledWith(undefined);
    expect(api.refreshClaude).not.toHaveBeenCalled();
    expect(out.status()).toBe(200);
  });

  it('reports 501 when the daemon has no Codex refresh (older reader)', async () => {
    const api = service();
    const out = response();
    await handleAccountAllowanceApi(
      request('/admin/api/accounts/allowances/refresh', { providerId: 'codex' }),
      out.res,
      'POST',
      ['refresh'],
      api,
    );
    expect(api.refreshClaude).not.toHaveBeenCalled();
    expect(out.status()).toBe(501);
  });

  it('returns secret-free allowance scheduling diagnostics', async () => {
    const api = service();
    api.getSchedulingStatus = vi.fn(() => ({
      config: {
        enabled: true,
        demoteAtPercent: 80,
        pauseAtPercent: 98,
        priorityPenalty: 100,
      },
      history: [],
    }));
    const out = response();
    await handleAccountAllowanceApi(
      request('/admin/api/accounts/allowances/scheduling'),
      out.res,
      'GET',
      ['scheduling'],
      api,
    );
    expect(out.status()).toBe(200);
    expect(out.json()).toMatchObject({
      scheduling: { config: { enabled: true }, history: [] },
    });
  });
});

describe('account allowance cycles route', () => {
  it('returns cycles from the reader', async () => {
    const api = service();
    api.getCycles = vi.fn(async () => [
      {
        providerId: 'codex',
        accountId: 'a',
        startTs: 1_000,
        endTs: null,
        resetsAt: '2026-09-19T09:41:06.000Z',
        kind: 'live',
        boundaryObservedAt: null,
      },
    ]);
    const out = response();
    await handleAccountAllowanceApi(
      request('/admin/api/accounts/allowances/cycles'),
      out.res,
      'GET',
      ['cycles'],
      api,
    );
    expect(out.status()).toBe(200);
    expect(out.json()).toMatchObject({
      cycles: [{ providerId: 'codex', accountId: 'a', startTs: 1_000, kind: 'live' }],
    });
  });

  it('threads providerId/accountId filters', async () => {
    const api = service();
    api.getCycles = vi.fn(async () => []);
    const out = response();
    await handleAccountAllowanceApi(
      request('/admin/api/accounts/allowances/cycles?providerId=codex&accountId=acc-9'),
      out.res,
      'GET',
      ['cycles'],
      api,
    );
    expect(out.status()).toBe(200);
    expect(api.getCycles).toHaveBeenCalledWith({ providerId: 'codex', accountId: 'acc-9' });
  });

  it('rejects an unknown providerId', async () => {
    const api = service();
    api.getCycles = vi.fn(async () => []);
    const out = response();
    await handleAccountAllowanceApi(
      request('/admin/api/accounts/allowances/cycles?providerId=nope'),
      out.res,
      'GET',
      ['cycles'],
      api,
    );
    expect(out.status()).toBe(400);
    expect(api.getCycles).not.toHaveBeenCalled();
  });

  it('reports 501 when the daemon predates cycle history', async () => {
    const api = service();
    const out = response();
    await handleAccountAllowanceApi(
      request('/admin/api/accounts/allowances/cycles'),
      out.res,
      'GET',
      ['cycles'],
      api,
    );
    expect(out.status()).toBe(501);
  });
});
