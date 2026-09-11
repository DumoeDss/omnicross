import type {
  GatewayBinding,
  GatewayBindingTarget,
  OutboundEndpointId,
} from '@/daemon/types';
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

/**
 * One upstream resource offered for direct key binding (the key-management
 * quick-bind picker). `endpoints` lists the ingress protocols a binding to
 * this resource can soundly serve — the quick-bind creates one passthrough
 * route per endpoint so the key is usable from any client protocol.
 */
export interface UpstreamBindingOption {
  key: string;
  label: string;
  detail: string;
  target: GatewayBindingTarget;
  endpoints: readonly OutboundEndpointId[];
}

/**
 * The ingress endpoints a direct binding to this upstream can soundly serve.
 * A BYO provider row works from every ingress (the transformer chain re-encodes
 * as needed). A subscription works from `messages` + `responses` (the chat
 * ingress's subscription bridge covers claude only, and the gemini ingress
 * stays BYO-only — see core's `endpointSupportsSubscription` /
 * `CHAT_BRIDGE_SUBSCRIPTION_PROVIDERS`).
 */
export function upstreamEndpointsForTarget(target: GatewayBindingTarget): OutboundEndpointId[] {
  if (target.kind === 'provider') return ['chat', 'responses', 'messages', 'gemini'];
  return target.providerId === 'claude'
    ? ['messages', 'responses', 'chat']
    : ['messages', 'responses'];
}

/** Same-target comparison (account ids / group names included). */
export function sameBindingTarget(left: GatewayBindingTarget, right: GatewayBindingTarget): boolean {
  if (left.kind !== right.kind || left.providerId !== right.providerId) return false;
  if (left.kind === 'account' && right.kind === 'account') return left.accountId === right.accountId;
  if (left.kind === 'account-group' && right.kind === 'account-group') return left.group === right.group;
  return true;
}

function createBindingId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `binding-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Bind one client key to one upstream resource directly: for each ingress
 * endpoint the upstream can serve, either ADD the key to an existing
 * same-target same-endpoint binding (no duplicate route) or CREATE a fresh
 * passthrough binding scoped to this key. `nameFor` labels created bindings
 * (the caller supplies the localized endpoint name). Pure — returns the next
 * bindings array.
 */
export function bindKeyToUpstream(
  bindings: readonly GatewayBinding[],
  keyId: string,
  option: UpstreamBindingOption,
  nameFor: (endpoint: OutboundEndpointId) => string,
): GatewayBinding[] {
  const next = bindings.map((binding) => ({ ...binding }));
  for (const endpoint of option.endpoints) {
    const existing = next.find(
      (binding) => binding.endpoint === endpoint && sameBindingTarget(binding.target, option.target),
    );
    if (existing) {
      if (!bindingAllowsClientKey(existing, keyId)) {
        existing.keyScope = 'selected';
        existing.apiKeyIds = [...new Set([...(existing.apiKeyIds ?? []), keyId])];
      }
      continue;
    }
    next.push({
      id: createBindingId(),
      name: `${option.label} · ${nameFor(endpoint)}`,
      enabled: true,
      keyScope: 'selected',
      apiKeyIds: [keyId],
      endpoint,
      target: option.target,
      priority: 100,
      fallback: 'fail',
      modelMode: 'passthrough',
    });
  }
  return next;
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
