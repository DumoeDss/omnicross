import { detectModelKind, isKindMappedEndpoint } from './kindDetection';
import { resolvePrefixTarget } from './modelPrefixDispatch';
import type {
  EndpointRoutingConfig,
  GatewayBinding,
  GatewayBindingTarget,
  ModelPrefixTargets,
  ModelRef,
  OutboundEndpoint,
  RequestRole,
} from './types';

export interface GatewayBindingResolution {
  source: 'binding' | 'global';
  binding?: GatewayBinding;
  config: EndpointRoutingConfig;
}
export interface ResolveGatewayBindingInput {
  bindings: readonly GatewayBinding[] | undefined;
  apiKeyId: string;
  endpoint: OutboundEndpoint;
  requestedModel?: string;
  role?: RequestRole;
  fallbackEndpointConfig: EndpointRoutingConfig;
}

const MESSAGE_FALLBACK_KINDS = ['sonnet', 'opus', 'haiku', 'fable'] as const;

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function routeCanServe(
  binding: GatewayBinding,
  requestedModel: string | undefined,
  role: RequestRole | undefined,
): boolean {
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

/** Project an independent resource binding into the legacy route resolver shape. */
export function gatewayBindingToEndpointConfig(binding: GatewayBinding): EndpointRoutingConfig {
  const target = binding.target;
  const config: EndpointRoutingConfig = {
    endpoint: binding.endpoint,
    useSubscription: target.kind !== 'provider',
  };

  if (isKindMappedEndpoint(binding.endpoint)) {
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

  if (target.kind === 'account') {
    config.boundAccountId = target.accountId;
    config.boundAccountFallbackPolicy = binding.fallback === 'global' ? 'pool' : 'strict';
  } else if (target.kind === 'account-group') {
    config.boundAccountGroup = target.group;
    config.boundAccountFallbackPolicy = binding.fallback === 'global' ? 'pool' : 'strict';
  } else if (target.keyId) {
    config.boundKeyId = target.keyId;
    config.boundKeyFallbackPolicy = binding.fallback === 'global' ? 'pool' : 'strict';
  }

  return config;
}

/**
 * Resolve the resource route for one verified client key. Exact key-scoped
 * bindings outrank unscoped bindings; lower priority values win. A binding with
 * `fallback: global` that has no model for this request yields to the legacy
 * endpoint config, while `fail` remains selected and produces an actionable
 * route error downstream.
 */
export function resolveGatewayBinding(input: ResolveGatewayBindingInput): GatewayBindingResolution {
  const candidates = (input.bindings ?? []).filter(
    (binding) =>
      binding.enabled &&
      binding.endpoint === input.endpoint &&
      (!binding.apiKeyIds || binding.apiKeyIds.length === 0 || binding.apiKeyIds.includes(input.apiKeyId)),
  );
  const scoped = candidates.filter((binding) => binding.apiKeyIds?.includes(input.apiKeyId));
  const pool = scoped.length > 0 ? scoped : candidates.filter((binding) => !binding.apiKeyIds?.length);
  pool.sort(
    (left, right) =>
      (left.priority ?? 100) - (right.priority ?? 100) || left.id.localeCompare(right.id),
  );

  const binding = pool.find(
    (candidate) =>
      candidate.fallback === 'fail' ||
      routeCanServe(candidate, input.requestedModel, input.role),
  );
  if (!binding) return { source: 'global', config: input.fallbackEndpointConfig };
  return {
    source: 'binding',
    binding,
    config: gatewayBindingToEndpointConfig(binding),
  };
}
