import { describe, expect, it } from 'vitest';

import { accountSchedulingState, DEFAULT_ACCOUNT_FILTERS, filterAndSortAccounts, flattenAccounts, summarizeAccounts } from '../../accountManagementModel';

import type { AccountsListResponse } from '@/daemon/types';

const data: AccountsListResponse = {
  accounts: [],
  providerAccounts: {
    claude: [
      { id: 'a', label: 'Alpha', status: 'authorized', hasAccessToken: true, isActive: true, enabled: true, schedulable: true, group: 'prod', tags: ['max'], priority: 20, health: 'healthy' },
      { id: 'b', label: 'Beta', status: 'expired', hasAccessToken: true, isActive: false, enabled: false, schedulable: false, group: 'lab', tags: ['old'], priority: 10, health: 'blocked' },
    ],
    codex: [], gemini: [], opencodego: [],
  },
};

describe('account management list model', () => {
  it('flattens, searches metadata, filters scheduling, and sorts', () => {
    const rows = flattenAccounts(data, []);
    expect(filterAndSortAccounts(rows, { ...DEFAULT_ACCOUNT_FILTERS, query: 'max' }).map((row) => row.id)).toEqual(['a']);
    expect(filterAndSortAccounts(rows, { ...DEFAULT_ACCOUNT_FILTERS, scheduling: 'disabled' }).map((row) => row.id)).toEqual(['b']);
    expect(filterAndSortAccounts(rows, { ...DEFAULT_ACCOUNT_FILTERS, sort: 'priority' }).map((row) => row.id)).toEqual(['b', 'a']);
  });

  it('summarizes routing and warning states', () => {
    expect(summarizeAccounts(flattenAccounts(data, []))).toEqual({ total: 2, schedulable: 1, excluded: 1, warnings: 1 });
  });

  it('distinguishes operator, health, allowance pause, and allowance demotion states', () => {
    const [base] = flattenAccounts(data, []);
    expect(accountSchedulingState({ ...base, enabled: false, schedulable: false })).toBe('disabled');
    expect(accountSchedulingState({ ...base, health: 'rate_limited', schedulable: false })).toBe('healthPaused');
    expect(accountSchedulingState({ ...base, allowanceAction: 'pause', schedulable: false })).toBe('allowancePaused');
    expect(accountSchedulingState({ ...base, allowanceAction: 'demote', allowanceEffectivePriority: 120 })).toBe('demoted');
    expect(accountSchedulingState(base)).toBe('schedulable');
  });

  it('sorts priority by the allowance-effective value used at runtime', () => {
    const rows = flattenAccounts(data, []);
    rows[0].allowanceEffectivePriority = 120;
    rows[1].priority = 100;
    expect(filterAndSortAccounts(rows, { ...DEFAULT_ACCOUNT_FILTERS, sort: 'priority' }).map((row) => row.id)).toEqual(['b', 'a']);
  });
});
