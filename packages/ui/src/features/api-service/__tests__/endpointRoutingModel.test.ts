import { describe, expect, it } from 'vitest';

import type { EndpointRoutingConfig } from '../../../daemon/types-server';
import {
  effectiveBoundAccountFallbackPolicy,
  setBoundAccount,
  setBoundAccountFallbackPolicy,
} from '../endpointRoutingModel';

const endpoint: EndpointRoutingConfig = {
  endpoint: 'messages',
  modelMap: { opus: 'claude,claude-opus' },
  useSubscription: true,
};

describe('bound-account endpoint editor policy', () => {
  it('treats a legacy binding without a policy as strict', () => {
    const bound = { ...endpoint, boundAccountId: 'acct-1' };
    expect(effectiveBoundAccountFallbackPolicy(bound)).toBe('strict');
    expect(setBoundAccount(bound, 'acct-1').boundAccountFallbackPolicy).toBe('strict');
  });

  it('keeps pool fallback explicit and clears it with the binding', () => {
    const bound = setBoundAccount(endpoint, 'acct-1');
    const pool = setBoundAccountFallbackPolicy(bound, 'pool');
    expect(pool.boundAccountId).toBe('acct-1');
    expect(pool.boundAccountFallbackPolicy).toBe('pool');

    const unbound = setBoundAccount(pool, '');
    expect(unbound).not.toHaveProperty('boundAccountId');
    expect(unbound).not.toHaveProperty('boundAccountFallbackPolicy');
  });

  it('ignores a stale policy when no account is bound', () => {
    const stale = { ...endpoint, boundAccountFallbackPolicy: 'pool' as const };
    expect(effectiveBoundAccountFallbackPolicy(stale)).toBeUndefined();
    expect(effectiveBoundAccountFallbackPolicy({
      ...stale,
      boundAccountId: '   ',
    })).toBeUndefined();
    expect(setBoundAccountFallbackPolicy(stale, 'strict')).not.toHaveProperty(
      'boundAccountFallbackPolicy',
    );
  });
});
