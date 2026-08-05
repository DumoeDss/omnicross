import type { GatewayBinding } from '@/daemon/types';
import type { AppRoute } from '@/shared/state/hashRoute';

export function routeForBinding(binding: GatewayBinding): AppRoute {
  if (binding.target.kind === 'account') {
    return {
      page: 'upstreams',
      upstreamKind: 'account',
      upstreamFilter: 'account',
      accountProvider: binding.target.providerId as AppRoute['accountProvider'],
      accountId: binding.target.accountId,
    };
  }
  if (binding.target.kind === 'account-group') {
    return {
      page: 'upstreams',
      upstreamKind: 'account-group',
      upstreamFilter: 'account-group',
      upstreamProviderId: binding.target.providerId,
      upstreamGroup: binding.target.group,
    };
  }
  return {
    page: 'upstreams',
    upstreamKind: 'provider',
    upstreamFilter: 'provider',
    upstreamProviderId: binding.target.providerId,
  };
}

export function bindingsForClientKey(
  bindings: readonly GatewayBinding[],
  keyId: string,
): GatewayBinding[] {
  return bindings.filter(
    (binding) => binding.enabled && (!binding.apiKeyIds?.length || binding.apiKeyIds.includes(keyId)),
  );
}

export function bindingTargetLabel(binding: GatewayBinding): string {
  if (binding.target.kind === 'account') {
    return `${binding.target.providerId} / ${binding.target.accountId}`;
  }
  if (binding.target.kind === 'account-group') {
    return `${binding.target.providerId} / ${binding.target.group}`;
  }
  return binding.target.providerId;
}

export function summarizeBindingCoverage(bindings: readonly GatewayBinding[]): {
  enabled: number;
  endpoints: number;
  keyScoped: number;
} {
  const enabled = bindings.filter((binding) => binding.enabled);
  return {
    enabled: enabled.length,
    endpoints: new Set(enabled.map((binding) => binding.endpoint)).size,
    keyScoped: enabled.filter((binding) => binding.apiKeyIds?.length).length,
  };
}
