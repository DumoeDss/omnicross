import type http from 'node:http';

import {
  __resetSharedAccountHealthForTests,
  getSharedAccountHealth,
} from '@omnicross/core/pipeline/SubscriptionAccountHealth';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

function request(
  method = 'GET',
  url = '/admin/api/accounts/claude/account-a/diagnostics',
): http.IncomingMessage {
  return {
    method,
    url,
  } as http.IncomingMessage;
}

afterEach(() => __resetSharedAccountHealthForTests());

describe('account diagnostics admin projection', () => {
  it('routes a manual account test through the deep connection-test service', async () => {
    const testAccountConnection = vi.fn(async () => ({
      ok: true,
      marked: false,
      tier: 'generation' as const,
      model: 'gpt-5.6-luna',
    }));
    const cheapProbe = vi.fn();
    const deps = {
      subscriptionTokenWriter: {
        listSanitizedAccounts: async () => ({ codex: [{ id: 'account-a' }] }),
      },
      accountProbeService: {
        getAllHistory: () => [],
        probeAccount: cheapProbe,
        testAccountConnection,
      },
    } as unknown as AdminApiDeps;
    const out = response();

    await handleAdminApi(
      request('POST', '/admin/api/accounts/codex/account-a/test'),
      out.res,
      '/admin/api/accounts/codex/account-a/test',
      deps,
    );

    expect(out.status()).toBe(200);
    expect(out.json()).toEqual({
      ok: true,
      marked: false,
      tier: 'generation',
      model: 'gpt-5.6-luna',
    });
    expect(testAccountConnection).toHaveBeenCalledWith('codex', 'account-a');
    expect(cheapProbe).not.toHaveBeenCalled();
  });

  it('exposes existing health edges plus allowance policy history without secrets', async () => {
    const health = getSharedAccountHealth();
    health.recordUpstreamOutcome('claude', 'account-a', {
      status: 429,
      resetHeaderSeconds: 2_000,
      bodyText: 'Bearer should never be retained',
      now: 1_000_000,
    });

    const deps = {
      subscriptionTokenWriter: {
        listSanitizedAccounts: async () => ({ claude: [{ id: 'account-a' }] }),
      },
      accountAllowanceService: {
        getSchedulingStatus: () => ({
          config: { enabled: true, demoteAtPercent: 80, pauseAtPercent: 98, priorityPenalty: 100 },
          history: [{
            providerId: 'claude',
            accountId: 'account-a',
            action: 'pause',
            reason: 'pause-threshold',
            basePriority: 50,
            effectivePriority: 50,
            schedulable: false,
            usedPercent: 99,
            observedAt: '1970-01-01T00:16:41.000Z',
            resumeAt: '1970-01-01T00:33:20.000Z',
            decidedAt: '1970-01-01T00:16:41.000Z',
          }],
        }),
      },
    } as unknown as AdminApiDeps;
    const out = response();

    await handleAdminApi(request(), out.res, '/admin/api/accounts/claude/account-a/diagnostics', deps);

    expect(out.status()).toBe(200);
    const diagnostics = (out.json() as { diagnostics: Array<Record<string, unknown>> }).diagnostics;
    expect(diagnostics.map((entry) => entry.kind)).toEqual(['allowance-policy', 'health-anomaly']);
    expect(diagnostics[1]).toMatchObject({ state: 'rate_limited', accountId: 'account-a' });
    expect(JSON.stringify(diagnostics)).not.toContain('Bearer');
  });

  it('does not reveal diagnostics for an account outside the sanitized registry', async () => {
    const deps = {
      subscriptionTokenWriter: {
        listSanitizedAccounts: async () => ({ claude: [] }),
      },
    } as unknown as AdminApiDeps;
    const out = response();

    await handleAdminApi(request(), out.res, '/admin/api/accounts/claude/account-a/diagnostics', deps);

    expect(out.status()).toBe(404);
  });
});
