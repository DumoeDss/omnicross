import type { GatewayBinding } from '@/daemon/types';
import type { AppRoute } from '@/shared/state/hashRoute';

export function routeForBinding(binding: GatewayBinding): AppRoute {
  return {
    page: 'upstreams',
    upstreamTab: 'routes',
    downstreamId: binding.id,
  };
}

export function bindingAllowsClientKey(binding: GatewayBinding, keyId: string): boolean {
  const scope = binding.keyScope ?? (binding.apiKeyIds?.length ? 'selected' : 'all');
  return scope === 'all' || Boolean(binding.apiKeyIds?.includes(keyId));
}

export function bindingsForClientKey(
  bindings: readonly GatewayBinding[],
  keyId: string,
): GatewayBinding[] {
  return bindings.filter(
    (binding) => binding.enabled && bindingAllowsClientKey(binding, keyId),
  );
}

/** Update one key-to-downstream assignment without changing any route details. */
export function setBindingForClientKey(
  bindings: readonly GatewayBinding[],
  allKeyIds: readonly string[],
  keyId: string,
  bindingId: string,
  selected: boolean,
): GatewayBinding[] {
  return bindings.map((binding) => {
    if (binding.id !== bindingId) return binding;
    const currentScope = binding.keyScope ?? (binding.apiKeyIds?.length ? 'selected' : 'all');
    if (selected) {
      if (currentScope === 'all' || binding.apiKeyIds?.includes(keyId)) return binding;
      return {
        ...binding,
        keyScope: 'selected',
        apiKeyIds: [...new Set([...(binding.apiKeyIds ?? []), keyId])],
      };
    }
    const currentIds = currentScope === 'all' ? [...allKeyIds] : [...(binding.apiKeyIds ?? [])];
    return {
      ...binding,
      keyScope: 'selected',
      apiKeyIds: currentIds.filter((id) => id !== keyId),
    };
  });
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
    keyScoped: enabled.filter(
      (binding) =>
        (binding.keyScope ?? (binding.apiKeyIds?.length ? 'selected' : 'all')) === 'selected',
    ).length,
  };
}
