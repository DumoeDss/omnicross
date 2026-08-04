import type {
  BoundAccountFallbackPolicy,
  EndpointRoutingConfig,
} from '@/daemon/types-server';

/**
 * Read the effective editor value. A legacy bound endpoint with no policy is
 * displayed as strict, while stale policy data on an unbound endpoint is
 * ignored.
 */
export function effectiveBoundAccountFallbackPolicy(
  endpoint: EndpointRoutingConfig,
): BoundAccountFallbackPolicy | undefined {
  if (!endpoint.boundAccountId?.trim()) return undefined;
  return endpoint.boundAccountFallbackPolicy === 'pool' ? 'pool' : 'strict';
}

/** Set or clear the account binding and keep the policy meaningful only with it. */
export function setBoundAccount(
  endpoint: EndpointRoutingConfig,
  accountId: string,
): EndpointRoutingConfig {
  const trimmed = accountId.trim();
  if (!trimmed) {
    const { boundAccountId: _boundAccountId, boundAccountFallbackPolicy: _policy, ...unbound } = endpoint;
    return unbound;
  }
  return {
    ...endpoint,
    boundAccountId: trimmed,
    boundAccountFallbackPolicy: effectiveBoundAccountFallbackPolicy(endpoint) ?? 'strict',
  };
}

/** Change fallback behavior only when an account is actually bound. */
export function setBoundAccountFallbackPolicy(
  endpoint: EndpointRoutingConfig,
  policy: BoundAccountFallbackPolicy,
): EndpointRoutingConfig {
  if (!endpoint.boundAccountId?.trim()) {
    const { boundAccountFallbackPolicy: _policy, ...unbound } = endpoint;
    return unbound;
  }
  return {
    ...endpoint,
    boundAccountId: endpoint.boundAccountId.trim(),
    boundAccountFallbackPolicy: policy,
  };
}
