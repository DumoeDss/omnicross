import type { AccountTokensConfig } from '@omnicross/contracts/account-tokens-types';
import { getSharedAccountAllowanceScheduling, __resetSharedAccountAllowanceSchedulingForTests } from '@omnicross/core/pipeline/AccountAllowanceScheduling';
import { getSharedAccountHealth, __resetSharedAccountHealthForTests } from '@omnicross/core/pipeline/SubscriptionAccountHealth';
import type { SubscriptionCredentialStore } from '@omnicross/subscriptions/ports/credential-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRouteLeaseSubscriptionPreflight } from '../routeLeaseSubscriptionPreflight';

function account(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    enabled: true,
    group: 'team-a',
    priority: 50,
    tokens: { accessToken: `token-${id}` },
    ...overrides,
  };
}

function credentials(accounts: Record<string, unknown>[]): SubscriptionCredentialStore {
  const config = {
    updatedAt: '2026-08-11T00:00:00.000Z',
    claudeAccounts: accounts,
  } as unknown as AccountTokensConfig;
  return { getFullConfig: vi.fn(async () => config) } as unknown as SubscriptionCredentialStore;
}

beforeEach(() => {
  __resetSharedAccountHealthForTests();
  __resetSharedAccountAllowanceSchedulingForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetSharedAccountHealthForTests();
  __resetSharedAccountAllowanceSchedulingForTests();
});

describe('Route Lease subscription preflight', () => {
  it('keeps exact account and account-group checks inside their requested boundary', async () => {
    const preflight = createRouteLeaseSubscriptionPreflight(credentials([
      account('account-a', { group: 'team-a', supportedModels: ['model-a'] }),
      account('account-b', { group: 'team-b', supportedModels: ['model-b'] }),
    ]));

    await expect(preflight.assertAvailable({
      kind: 'account', providerId: 'claude', accountId: 'account-a',
    }, 'model-a')).resolves.toBeUndefined();
    await expect(preflight.assertAvailable({
      kind: 'account', providerId: 'claude', accountId: 'missing-account',
    }, 'model-a')).rejects.toMatchObject({ code: 'upstream_not_found' });
    await expect(preflight.assertAvailable({
      kind: 'account-group', providerId: 'claude', group: 'team-a',
    }, 'model-b')).rejects.toMatchObject({ code: 'model_not_configured' });
    await expect(preflight.assertAvailable({
      kind: 'account-group', providerId: 'claude', group: 'missing-group',
    }, 'model-a')).rejects.toMatchObject({ code: 'upstream_not_found' });
  });

  it.each([
    ['disabled', { enabled: false }],
    ['credential-less', { tokens: {} }],
  ] as const)('maps an unavailable strict account (%s) without pool fallback', async (_name, overrides) => {
    const preflight = createRouteLeaseSubscriptionPreflight(credentials([
      account('account-a', overrides),
      account('account-b', { group: 'team-b' }),
    ]));
    await expect(preflight.assertAvailable({
      kind: 'account', providerId: 'claude', accountId: 'account-a',
    }, 'model-a')).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });

  it('uses health, allowance, and priority when deciding pool availability', async () => {
    const health = vi.spyOn(getSharedAccountHealth(), 'isSchedulable')
      .mockImplementation((_providerId, accountId) => accountId !== 'health-blocked');
    const allowance = vi.spyOn(getSharedAccountAllowanceScheduling(), 'preview')
      .mockImplementation((providerId, accountId, priority) => ({
        providerId,
        accountId,
        action: accountId === 'allowance-paused' ? 'pause' : 'normal',
        reason: accountId === 'allowance-paused' ? 'pause-threshold' : 'below-threshold',
        basePriority: priority,
        effectivePriority: priority,
        schedulable: accountId !== 'allowance-paused',
        decidedAt: '2026-08-11T00:00:00.000Z',
      }));
    const preflight = createRouteLeaseSubscriptionPreflight(credentials([
      account('health-blocked', { priority: 10 }),
      account('allowance-paused', { priority: 20 }),
      account('eligible', { priority: 7 }),
    ]));

    await expect(preflight.assertAvailable({
      kind: 'account-pool', providerId: 'claude',
    }, 'model-a')).resolves.toBeUndefined();
    expect(health).toHaveBeenCalledWith('claude', 'eligible');
    expect(allowance).toHaveBeenCalledWith('claude', 'eligible', 7);

    allowance.mockImplementation((providerId, accountId, priority) => ({
      providerId,
      accountId,
      action: 'pause',
      reason: 'pause-threshold',
      basePriority: priority,
      effectivePriority: priority,
      schedulable: false,
      decidedAt: '2026-08-11T00:00:00.000Z',
    }));
    await expect(preflight.assertAvailable({
      kind: 'account-pool', providerId: 'claude',
    }, 'model-a')).rejects.toMatchObject({
      code: 'upstream_exhausted',
      retryAfterSeconds: 30,
    });
  });

  it('distinguishes an unsupported provider and an empty configured provider pool', async () => {
    const empty = createRouteLeaseSubscriptionPreflight(credentials([]));
    await expect(empty.assertAvailable({
      kind: 'account-pool', providerId: 'claude',
    }, 'model-a')).rejects.toMatchObject({ code: 'upstream_unavailable' });
    await expect(empty.assertAvailable({
      kind: 'account-pool', providerId: 'unknown-subscription',
    }, 'model-a')).rejects.toMatchObject({ code: 'upstream_not_found' });
  });
});
