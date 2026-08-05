import type {
  GatewayBinding,
  GatewayBindingTarget,
  OutboundEndpointId,
} from '@/daemon/types';

import { modelKindsForEndpoint } from '../api-service/endpointKinds';

export interface BindingDraft {
  id?: string;
  name: string;
  enabled: boolean;
  endpoint: OutboundEndpointId;
  apiKeyIds: string[];
  priority: string;
  fallback: GatewayBinding['fallback'];
  providerKeyId: string;
  modelMap: Record<string, string>;
  modelsText: string;
  defaultModel: string;
  backgroundModel: string;
  backgroundModelIdsText: string;
}

export function newBindingDraft(): BindingDraft {
  return {
    name: '',
    enabled: true,
    endpoint: 'responses',
    apiKeyIds: [],
    priority: '100',
    fallback: 'fail',
    providerKeyId: '',
    modelMap: {},
    modelsText: '',
    defaultModel: '',
    backgroundModel: '',
    backgroundModelIdsText: '',
  };
}

/** A provider resource owns every binding for that provider, regardless of key scope. */
export function bindingMatchesTarget(
  binding: GatewayBinding,
  target: GatewayBindingTarget,
): boolean {
  if (binding.target.kind !== target.kind || binding.target.providerId !== target.providerId) {
    return false;
  }
  if (target.kind === 'account' && binding.target.kind === 'account') {
    return binding.target.accountId === target.accountId;
  }
  if (target.kind === 'account-group' && binding.target.kind === 'account-group') {
    return binding.target.group === target.group;
  }
  return target.kind === 'provider';
}

export function parseBindingList(value: string): string[] {
  return [...new Set(value.split(/[\n,]/u).map((part) => part.trim()).filter(Boolean))];
}

export function bindingDraftFromBinding(binding: GatewayBinding): BindingDraft {
  return {
    id: binding.id,
    name: binding.name,
    enabled: binding.enabled,
    endpoint: binding.endpoint,
    apiKeyIds: binding.apiKeyIds ?? [],
    priority: String(binding.priority ?? 100),
    fallback: binding.fallback,
    providerKeyId: binding.target.kind === 'provider' ? binding.target.keyId ?? '' : '',
    modelMap: binding.modelMap ?? {},
    modelsText: (binding.models ?? []).join('\n'),
    defaultModel: binding.defaultModel ?? '',
    backgroundModel: binding.backgroundModel ?? '',
    backgroundModelIdsText: (binding.backgroundModelIds ?? []).join(', '),
  };
}

function createBindingId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `binding-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function bindingFromDraft(
  draft: BindingDraft,
  target: GatewayBindingTarget,
  idFactory: () => string = createBindingId,
): GatewayBinding {
  const priority = Number.parseInt(draft.priority, 10);
  const resolvedTarget = target.kind === 'provider'
    ? { ...target, keyId: draft.providerKeyId || undefined }
    : target;
  const binding: GatewayBinding = {
    id: draft.id ?? idFactory(),
    name: draft.name.trim(),
    enabled: draft.enabled,
    endpoint: draft.endpoint,
    target: resolvedTarget,
    fallback: draft.fallback,
    priority: Number.isFinite(priority) ? Math.min(10_000, Math.max(0, priority)) : 100,
  };
  if (draft.apiKeyIds.length) binding.apiKeyIds = draft.apiKeyIds;
  if (draft.endpoint === 'messages' || draft.endpoint === 'responses') {
    binding.modelMap = Object.fromEntries(
      modelKindsForEndpoint(draft.endpoint).map((kind) => [kind, draft.modelMap[kind]?.trim() ?? '']),
    );
  } else if (draft.endpoint === 'chat') {
    binding.models = parseBindingList(draft.modelsText);
    binding.dispatchMode = 'list';
  } else {
    binding.defaultModel = draft.defaultModel.trim();
    binding.backgroundModel = draft.backgroundModel.trim();
    const ids = parseBindingList(draft.backgroundModelIdsText);
    if (ids.length) binding.backgroundModelIds = ids;
  }
  return binding;
}

export function bindingModelSummary(binding: GatewayBinding): string {
  if (binding.endpoint === 'messages' || binding.endpoint === 'responses') {
    return Object.entries(binding.modelMap ?? {})
      .filter(([, model]) => model.trim())
      .map(([kind, model]) => `${kind}:${model.includes(',') ? model.slice(model.indexOf(',') + 1) : model}`)
      .join(' · ');
  }
  if (binding.endpoint === 'chat') return (binding.models ?? []).join(', ');
  return [binding.defaultModel, binding.backgroundModel].filter(Boolean).join(' / ');
}

export function canSaveBindingDraft(draft: BindingDraft): boolean {
  if (!draft.name.trim()) return false;
  if (draft.endpoint === 'messages' || draft.endpoint === 'responses') {
    return modelKindsForEndpoint(draft.endpoint).some((kind) => draft.modelMap[kind]?.trim());
  }
  if (draft.endpoint === 'chat') return parseBindingList(draft.modelsText).length > 0;
  return Boolean(draft.defaultModel.trim());
}
