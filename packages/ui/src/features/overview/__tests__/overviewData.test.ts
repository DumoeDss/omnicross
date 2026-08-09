import { describe, expect, it } from 'vitest';

import type { SubscriptionAccountSanitized } from '../../../daemon/types-accounts';
import { normalizeOverviewAccounts } from '../overviewData';

const codexAccount: SubscriptionAccountSanitized = {
  id: 'codex-1',
  label: 'Codex',
  enabled: true,
  group: 'codex',
  tags: [],
  status: 'authorized',
  hasAccessToken: true,
  isActive: true,
  schedulable: true,
};

describe('normalizeOverviewAccounts', () => {
  it('fills missing provider keys in a sparse daemon projection', () => {
    const result = normalizeOverviewAccounts({
      accounts: [],
      providerAccounts: { codex: [codexAccount] },
    });

    expect(result.providerAccounts.codex).toEqual([codexAccount]);
    expect(result.providerAccounts.claude).toEqual([]);
    expect(result.providerAccounts.gemini).toEqual([]);
    expect(result.providerAccounts.opencodego).toEqual([]);
  });

  it('still rejects a response with no provider projection', () => {
    expect(() => normalizeOverviewAccounts({ accounts: [] })).toThrow('Account data was incomplete');
  });
});
