import { detectModelKind, isKindMappedEndpoint, modelKindsForEndpoint } from './kindDetection';
import { resolvePrefixTarget } from './modelPrefixDispatch';
import type {
  EndpointRoutingConfig,
  GatewayBinding,
  GatewayBindingTarget,
  GatewayModelMapping,
  ModelPrefixTargets,
  ModelRef,
  OutboundEndpoint,
  RequestRole,
} from './types';

/**
 * Either the winning route projected to the resolver shape, or `none` — no
 * enabled route for this key/endpoint could serve the request. There is no
 * global fallback: `none` is terminal and the caller answers with a route error.
 */
export type GatewayBindingResolution =
  | { source: 'binding'; binding: GatewayBinding; config: EndpointRoutingConfig }
  | { source: 'none' };

export interface ResolveGatewayBindingInput {
  bindings: readonly GatewayBinding[] | undefined;
  apiKeyId: string;
  endpoint: OutboundEndpoint;
  requestedModel?: string;
  role?: RequestRole;
}

const MESSAGE_FALLBACK_KINDS = ['sonnet', 'opus', 'haiku', 'fable'] as const;

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Preserve legacy unscoped bindings while allowing new routes to start with no keys. */
export function gatewayBindingAllowsKey(binding: GatewayBinding, apiKeyId: string): boolean {
  const scope = binding.keyScope ?? (binding.apiKeyIds?.length ? 'selected' : 'all');
  return scope === 'all' || Boolean(binding.apiKeyIds?.includes(apiKeyId));
}

function wildcardMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'iu').test(value);
}

/** Resolve the first exact/wildcard mapping in declaration order. */
export function resolveGatewayModelMapping(
  mappings: readonly GatewayModelMapping[] | undefined,
  requestedModel: string | undefined,
): string | undefined {
  if (!nonBlank(requestedModel)) return undefined;
  const wanted = requestedModel.trim();
  const exact = (mappings ?? []).find(
    (mapping) => nonBlank(mapping.source) && !mapping.source.includes('*') && mapping.source.trim().toLocaleLowerCase() === wanted.toLocaleLowerCase(),
  );
  if (exact && nonBlank(exact.target)) return exact.target.trim();
  const wildcard = (mappings ?? []).find(
    (mapping) => nonBlank(mapping.source) && mapping.source.includes('*') && wildcardMatches(mapping.source.trim(), wanted),
  );
  return wildcard && nonBlank(wildcard.target) ? wildcard.target.trim() : undefined;
}

function routeCanServe(
  binding: GatewayBinding,
  requestedModel: string | undefined,
  role: RequestRole | undefined,
): boolean {
  if (binding.modelMode === 'passthrough') return nonBlank(requestedModel);
  if (binding.modelMappings?.length) {
    return nonBlank(resolveGatewayModelMapping(binding.modelMappings, requestedModel));
  }
  if (isKindMappedEndpoint(binding.endpoint)) {
    const map = binding.modelMap ?? {};
    const kind = detectModelKind(binding.endpoint, requestedModel);
    if (kind && nonBlank(map[kind])) return true;
    if (binding.endpoint === 'messages') {
      return MESSAGE_FALLBACK_KINDS.some((candidate) => nonBlank(map[candidate]));
    }
    return nonBlank(map.codex);
  }

  if (binding.endpoint === 'chat' && binding.dispatchMode === 'prefix') {
    return resolvePrefixTarget(binding.prefixTargets, requestedModel) !== null;
  }
  if (binding.endpoint === 'chat') {
    if (!requestedModel) return false;
    const wanted = requestedModel.trim().toLowerCase();
    return (binding.models ?? []).some((ref) => modelIdOf(ref)?.toLowerCase() === wanted);
  }

  return role === 'background'
    ? nonBlank(binding.backgroundModel)
    : nonBlank(binding.defaultModel);
}

function modelIdOf(ref: string | undefined): string | undefined {
  if (!nonBlank(ref)) return undefined;
  const trimmed = ref.trim();
  const comma = trimmed.indexOf(',');
  const modelId = comma >= 0 ? trimmed.slice(comma + 1).trim() : trimmed;
  return modelId || undefined;
}

function targetProviderId(target: GatewayBindingTarget): string {
  return target.providerId.trim();
}

function targetRef(target: GatewayBindingTarget, ref: string | undefined): ModelRef {
  const modelId = modelIdOf(ref) ?? '';
  return modelId ? `${targetProviderId(target)},${modelId}` : '';
}

function targetRefs(target: GatewayBindingTarget, refs: readonly string[] | undefined): ModelRef[] {
  return (refs ?? []).map((ref) => targetRef(target, ref)).filter(nonBlank);
}

function targetPrefixRefs(
  target: GatewayBindingTarget,
  refs: ModelPrefixTargets | undefined,
): ModelPrefixTargets | undefined {
  if (!refs) return undefined;
  const mapped: ModelPrefixTargets = {};
  for (const kind of ['claude', 'gpt', 'gemini'] as const) {
    const ref = targetRef(target, refs[kind]);
    if (ref) mapped[kind] = ref;
  }
  return mapped.claude || mapped.gpt || mapped.gemini ? mapped : undefined;
}

function applySingleModel(
  config: EndpointRoutingConfig,
  binding: GatewayBinding,
  targetModel: string,
): void {
  const ref = targetRef(binding.target, targetModel);
  if (!ref) return;
  if (isKindMappedEndpoint(binding.endpoint)) {
    config.modelMap = Object.fromEntries(
      modelKindsForEndpoint(binding.endpoint).map((kind) => [kind, ref]),
    );
  } else if (binding.endpoint === 'chat') {
    config.models = [ref];
    config.dispatchMode = 'list';
  } else {
    config.defaultModel = ref;
    config.backgroundModel = ref;
  }
}

/** Project one downstream route into the legacy route-resolver shape. */
export function gatewayBindingToEndpointConfig(
  binding: GatewayBinding,
  requestedModel?: string,
): EndpointRoutingConfig {
  const target = binding.target;
  const config: EndpointRoutingConfig = {
    endpoint: binding.endpoint,
    useSubscription: target.kind !== 'provider',
  };

  const usesGenericModelHandling =
    binding.modelMode === 'passthrough' || Boolean(binding.modelMappings?.length);
  const dynamicModel = binding.modelMode === 'passthrough'
    ? requestedModel
    : resolveGatewayModelMapping(binding.modelMappings, requestedModel);

  if (usesGenericModelHandling) {
    if (nonBlank(dynamicModel)) applySingleModel(config, binding, dynamicModel);
  } else if (isKindMappedEndpoint(binding.endpoint)) {
    config.modelMap = Object.fromEntries(
      Object.entries(binding.modelMap ?? {}).map(([kind, ref]) => [kind, targetRef(target, ref)]),
    );
  } else if (binding.endpoint === 'chat') {
    config.models = targetRefs(target, binding.models);
    if (binding.dispatchMode === 'prefix') {
      config.dispatchMode = 'prefix';
      config.prefixTargets = targetPrefixRefs(target, binding.prefixTargets);
    }
  } else {
    config.defaultModel = targetRef(target, binding.defaultModel);
    config.backgroundModel = targetRef(target, binding.backgroundModel);
    if (binding.backgroundModelIds) config.backgroundModelIds = [...binding.backgroundModelIds];
  }

  // `account-pool` deliberately sets no bound* hint: `useSubscription` alone is
  // plain provider-pool scheduling (priority/LRU/health), which is exactly what
  // the target means.
  if (target.kind === 'account') {
    config.boundAccountId = target.accountId;
    config.boundAccountFallbackPolicy = binding.fallback === 'next' ? 'pool' : 'strict';
  } else if (target.kind === 'account-group') {
    config.boundAccountGroup = target.group;
    config.boundAccountFallbackPolicy = binding.fallback === 'next' ? 'pool' : 'strict';
  } else if (target.kind === 'provider' && target.keyId) {
    config.boundKeyId = target.keyId;
    config.boundKeyFallbackPolicy = binding.fallback === 'next' ? 'pool' : 'strict';
  }

  return config;
}

/**
 * The enabled routes one verified key may enter on one endpoint, in resolution
 * order. Exact key-scoped routes outrank unscoped ones (and suppress them
 * entirely); within a tier the lower priority value wins, id breaking ties.
 */
export function candidateGatewayBindings(
  bindings: readonly GatewayBinding[] | undefined,
  apiKeyId: string,
  endpoint: OutboundEndpoint,
): GatewayBinding[] {
  const candidates = (bindings ?? []).filter(
    (binding) =>
      binding.enabled &&
      binding.endpoint === endpoint &&
      gatewayBindingAllowsKey(binding, apiKeyId),
  );
  const scopeOf = (binding: GatewayBinding) =>
    binding.keyScope ?? (binding.apiKeyIds?.length ? 'selected' : 'all');
  const scoped = candidates.filter((binding) => scopeOf(binding) === 'selected');
  const pool = scoped.length > 0
    ? scoped
    : candidates.filter((binding) => scopeOf(binding) === 'all');
  return pool.sort(
    (left, right) =>
      (left.priority ?? 100) - (right.priority ?? 100) || left.id.localeCompare(right.id),
  );
}

/**
 * The background-tier model ids the role-based endpoint should recognize for
 * this request. Role detection runs BEFORE a route is picked (the pick needs the
 * role), so the hint is the union across every candidate route.
 */
export function candidateBackgroundModelIds(
  bindings: readonly GatewayBinding[] | undefined,
  apiKeyId: string,
  endpoint: OutboundEndpoint,
): string[] | undefined {
  const ids = [
    ...new Set(
      candidateGatewayBindings(bindings, apiKeyId, endpoint).flatMap(
        (binding) => binding.backgroundModelIds ?? [],
      ),
    ),
  ];
  return ids.length > 0 ? ids : undefined;
}

/**
 * Resolve the resource route for one verified client key. A route with
 * `fallback: next` that has no model for this request yields to the next
 * candidate, while `fail` remains selected immediately.
 *
 * When no candidate can serve, the FIRST candidate is still selected so route
 * resolution produces its specific, actionable error (e.g. 404 for a model
 * outside a chat route's list) rather than a generic one. `none` is reserved
 * for having no candidate route at all.
 */
export function resolveGatewayBinding(input: ResolveGatewayBindingInput): GatewayBindingResolution {
  const candidates = candidateGatewayBindings(input.bindings, input.apiKeyId, input.endpoint);
  const binding = candidates.find(
    (candidate) =>
      candidate.fallback === 'fail' ||
      routeCanServe(candidate, input.requestedModel, input.role),
  ) ?? candidates[0];
  if (!binding) return { source: 'none' };
  return {
    source: 'binding',
    binding,
    config: gatewayBindingToEndpointConfig(binding, input.requestedModel),
  };
}
