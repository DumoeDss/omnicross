import { describe, expect, it } from 'vitest';

import { validateAccountBatchBody, validateAccountMetadataPatch } from '../admin/accountsWrite';

describe('account management wire validation', () => {
  it('normalizes safe metadata and rejects unknown/token fields', () => {
    expect(validateAccountMetadataPatch({ label: ' Work ', enabled: false, group: ' Team ', tags: [' max ', 'max'] })).toEqual({
      label: 'Work', enabled: false, group: 'Team', tags: ['max'],
    });
    expect(validateAccountMetadataPatch({ accessToken: 'secret' })).toBeNull();
    expect(validateAccountMetadataPatch({ tags: Array.from({ length: 21 }, (_, index) => String(index)) })).toBeNull();
  });

  it('accepts bounded batches and rejects unknown providers, duplicates, and oversize sets', () => {
    expect(validateAccountBatchBody({ action: 'set-group', group: ' ops ', accounts: [{ providerId: 'claude', accountId: 'a' }] })).toEqual({
      refs: [{ providerId: 'claude', accountId: 'a' }], mutation: { action: 'set-group', group: 'ops' },
    });
    expect(validateAccountBatchBody({ action: 'disable', accounts: [{ providerId: 'other', accountId: 'a' }] })).toBeNull();
    expect(validateAccountBatchBody({ action: 'disable', accounts: [{ providerId: 'claude', accountId: 'a' }, { providerId: 'claude', accountId: 'a' }] })).toBeNull();
  });
});
