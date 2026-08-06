import {
  ArrowRight,
  Cable,
  Check,
  KeyRound,
  Pencil,
  Plus,
  Route,
  Server,
  Shuffle,
  Trash2,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, type SelectOption } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type {
  GatewayBinding,
  GatewayBindingTarget,
  GatewayModelMapping,
  OutboundApiKeyInfo,
  OutboundEndpointId,
} from '@/daemon/types';
import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';

export interface DownstreamResourceOption {
  key: string;
  label: string;
  detail: string;
  target: GatewayBindingTarget;
  egressProtocol: string;
  modelSuggestions: string[];
}

interface DownstreamRoutesWorkspaceProps {
  bindings: GatewayBinding[];
  resources: DownstreamResourceOption[];
  clientKeys: OutboundApiKeyInfo[];
  selectedBindingId?: string;
  busy: boolean;
  onSelectBinding: (bindingId?: string) => void;
  onOpenApiKeys: () => void;
  onChange: (bindings: GatewayBinding[]) => Promise<void> | void;
}

interface MappingDraft {
  source: string;
  target: string;
}

interface DownstreamDraft {
  id?: string;
  name: string;
  enabled: boolean;
  endpoint: OutboundEndpointId;
  resourceKey: string;
  priority: string;
  fallback: GatewayBinding['fallback'];
  modelMode: 'passthrough' | 'mapped';
  mappings: MappingDraft[];
}

const ENDPOINTS: OutboundEndpointId[] = ['messages', 'responses', 'chat', 'gemini'];

function createBindingId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `binding-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function stripProvider(ref: string): string {
  const comma = ref.indexOf(',');
  return comma >= 0 ? ref.slice(comma + 1).trim() : ref.trim();
}

function legacyMappings(binding: GatewayBinding): MappingDraft[] {
  if (binding.endpoint === 'messages') {
    return Object.entries(binding.modelMap ?? {})
      .filter(([, target]) => target.trim())
      .map(([kind, target]) => ({ source: `*${kind}*`, target: stripProvider(target) }));
  }
  if (binding.endpoint === 'responses') {
    const map = binding.modelMap ?? {};
    const result: MappingDraft[] = [];
    if (map.mini?.trim()) result.push({ source: '*mini*', target: stripProvider(map.mini) });
    if (map.codex?.trim()) result.push({ source: '*', target: stripProvider(map.codex) });
    return result;
  }
  if (binding.endpoint === 'chat') {
    if (binding.dispatchMode === 'prefix') {
      return (['claude', 'gpt', 'gemini'] as const).flatMap((prefix) => {
        const target = binding.prefixTargets?.[prefix];
        return target?.trim()
          ? [{ source: `${prefix}-*`, target: stripProvider(target) }]
          : [];
      });
    }
    return (binding.models ?? [])
      .filter((model) => model.trim())
      .map((model) => {
        const target = stripProvider(model);
        return { source: target, target };
      });
  }
  const result = (binding.backgroundModelIds ?? []).flatMap((source) => {
    const target = binding.backgroundModel?.trim();
    return source.trim() && target
      ? [{ source: source.trim(), target: stripProvider(target) }]
      : [];
  });
  const fallback = binding.defaultModel?.trim() || binding.backgroundModel?.trim();
  if (fallback) result.push({ source: '*', target: stripProvider(fallback) });
  return result;
}

function sameMappings(left: readonly MappingDraft[], right: readonly MappingDraft[]): boolean {
  return left.length === right.length
    && left.every((mapping, index) => (
      mapping.source.trim() === right[index]?.source.trim()
      && mapping.target.trim() === right[index]?.target.trim()
    ));
}

function targetMatches(left: GatewayBindingTarget, right: GatewayBindingTarget): boolean {
  if (left.kind !== right.kind || left.providerId !== right.providerId) return false;
  if (left.kind === 'account' && right.kind === 'account') return left.accountId === right.accountId;
  if (left.kind === 'account-group' && right.kind === 'account-group') return left.group === right.group;
  return left.kind === 'provider' && right.kind === 'provider';
}

function resourceForBinding(
  resources: readonly DownstreamResourceOption[],
  binding: GatewayBinding,
): DownstreamResourceOption | undefined {
  return resources.find((resource) => targetMatches(resource.target, binding.target));
}

function draftFromBinding(
  binding: GatewayBinding,
  resources: readonly DownstreamResourceOption[],
): DownstreamDraft {
  const mappings = binding.modelMappings?.map((mapping) => ({ ...mapping })) ?? legacyMappings(binding);
  return {
    id: binding.id,
    name: binding.name,
    enabled: binding.enabled,
    endpoint: binding.endpoint,
    resourceKey: resourceForBinding(resources, binding)?.key ?? resources[0]?.key ?? '',
    priority: String(binding.priority ?? 100),
    fallback: binding.fallback,
    modelMode: binding.modelMode ?? (mappings.length ? 'mapped' : 'passthrough'),
    mappings,
  };
}

function newDraft(resources: readonly DownstreamResourceOption[]): DownstreamDraft {
  return {
    name: '',
    enabled: true,
    endpoint: 'messages',
    resourceKey: resources[0]?.key ?? '',
    priority: '100',
    fallback: 'fail',
    modelMode: 'passthrough',
    mappings: [],
  };
}

function canSave(draft: DownstreamDraft): boolean {
  if (!draft.name.trim() || !draft.resourceKey) return false;
  if (draft.modelMode === 'passthrough') return true;
  return draft.mappings.length > 0
    && draft.mappings.every((mapping) => mapping.source.trim() && mapping.target.trim());
}

function bindingFromDraft(
  draft: DownstreamDraft,
  resource: DownstreamResourceOption,
  previous?: GatewayBinding,
): GatewayBinding {
  const priority = Number.parseInt(draft.priority, 10);
  const target = resource.target.kind === 'provider'
    && previous?.target.kind === 'provider'
    && previous.target.providerId === resource.target.providerId
    && previous.target.keyId
    ? { ...resource.target, keyId: previous.target.keyId }
    : resource.target;
  const binding: GatewayBinding = {
    id: draft.id ?? createBindingId(),
    name: draft.name.trim(),
    enabled: draft.enabled,
    keyScope: previous
      ? previous.keyScope ?? (previous.apiKeyIds?.length ? 'selected' : 'all')
      : 'selected',
    endpoint: draft.endpoint,
    target,
    priority: Number.isFinite(priority) ? Math.max(0, Math.min(10_000, priority)) : 100,
    fallback: draft.fallback,
    modelMode: draft.modelMode,
  };
  if (previous?.apiKeyIds?.length) binding.apiKeyIds = [...previous.apiKeyIds];
  if (draft.modelMode === 'mapped') {
    const preserveLegacyModels = previous
      && previous.endpoint === draft.endpoint
      && !previous.modelMappings?.length
      && sameMappings(draft.mappings, legacyMappings(previous));
    if (preserveLegacyModels) {
      if (previous.modelMap) binding.modelMap = { ...previous.modelMap };
      if (previous.models) binding.models = [...previous.models];
      if (previous.dispatchMode) binding.dispatchMode = previous.dispatchMode;
      if (previous.prefixTargets) binding.prefixTargets = { ...previous.prefixTargets };
      if (previous.defaultModel !== undefined) binding.defaultModel = previous.defaultModel;
      if (previous.backgroundModel !== undefined) binding.backgroundModel = previous.backgroundModel;
      if (previous.backgroundModelIds) binding.backgroundModelIds = [...previous.backgroundModelIds];
    } else {
      binding.modelMappings = draft.mappings.map((mapping) => ({
        source: mapping.source.trim(),
        target: mapping.target.trim(),
      }));
    }
  }
  return binding;
}

function appliesToKey(binding: GatewayBinding, keyId: string): boolean {
  const scope = binding.keyScope ?? (binding.apiKeyIds?.length ? 'selected' : 'all');
  return scope === 'all' || Boolean(binding.apiKeyIds?.includes(keyId));
}

export function DownstreamRoutesWorkspace({
  bindings,
  resources,
  clientKeys,
  selectedBindingId,
  busy,
  onSelectBinding,
  onOpenApiKeys,
  onChange,
}: DownstreamRoutesWorkspaceProps) {
  const t = useTranslation();
  const selected = bindings.find((binding) => binding.id === selectedBindingId)
    ?? bindings[0]
    ?? null;
  const [draft, setDraft] = useState<DownstreamDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GatewayBinding | null>(null);
  const editorDraft = draft
    ?? (selected ? draftFromBinding(selected, resources) : null);
  const selectedResource = editorDraft
    ? resources.find((resource) => resource.key === editorDraft.resourceKey)
    : undefined;

  const endpointOptions = useMemo<SelectOption[]>(
    () => ENDPOINTS.map((endpoint) => ({
      value: endpoint,
      label: t(`apiService.endpoint.name.${endpoint}`),
    })),
    [t],
  );
  const resourceOptions = useMemo<SelectOption[]>(
    () => resources.map((resource) => ({ value: resource.key, label: resource.label })),
    [resources],
  );
  const fallbackOptions = useMemo<SelectOption[]>(
    () => [
      { value: 'fail', label: t('upstreams.routes.fallback.fail') },
      { value: 'next', label: t('upstreams.routes.fallback.next') },
    ],
    [t],
  );

  const beginCreate = () => {
    setDraft(newDraft(resources));
    onSelectBinding(undefined);
  };

  const save = async () => {
    if (!editorDraft || !canSave(editorDraft)) return;
    const resource = resources.find((item) => item.key === editorDraft.resourceKey);
    if (!resource) return;
    const previous = editorDraft.id ? bindings.find((binding) => binding.id === editorDraft.id) : undefined;
    const nextBinding = bindingFromDraft(editorDraft, resource, previous);
    const next = previous
      ? bindings.map((binding) => binding.id === previous.id ? nextBinding : binding)
      : [...bindings, nextBinding];
    await onChange(next);
    setDraft(null);
    onSelectBinding(nextBinding.id);
  };

  const remove = async () => {
    if (!deleteTarget) return;
    await onChange(bindings.filter((binding) => binding.id !== deleteTarget.id));
    setDeleteTarget(null);
    setDraft(null);
    onSelectBinding(undefined);
  };

  const patch = (next: Partial<DownstreamDraft>) => {
    if (!editorDraft) return;
    setDraft({ ...editorDraft, ...next });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row" data-testid="downstream-routes-workspace">
      <aside className="flex h-[38%] min-h-56 shrink-0 flex-col border-b border-border/70 bg-surface-1/35 md:h-full md:w-72 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-3">
          <div>
            <h2 className="text-xs font-semibold text-foreground">{t('upstreams.downstreams.listTitle')}</h2>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {t('upstreams.downstreams.listCount', { count: bindings.length })}
            </p>
          </div>
          <Button size="icon" variant="ghost" disabled={busy || !resources.length} onClick={beginCreate} aria-label={t('upstreams.downstreams.add')}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-1 p-2">
            {bindings.map((binding) => {
              const active = !draft && selected?.id === binding.id;
              const resource = resourceForBinding(resources, binding);
              const keyCount = clientKeys.filter((key) => !key.revoked && appliesToKey(binding, key.id)).length;
              return (
                <button
                  key={binding.id}
                  type="button"
                  className={cn(
                    'flex min-h-14 w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active ? 'border-primary/35 bg-primary/8' : 'border-transparent hover:border-border hover:bg-surface-1',
                  )}
                  onClick={() => { setDraft(null); onSelectBinding(binding.id); }}
                >
                  <span className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border',
                    active ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border bg-surface-0 text-muted-foreground',
                  )}>
                    <Cable className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-foreground">{binding.name}</span>
                    <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                      {t(`apiService.endpoint.name.${binding.endpoint}`)} · {resource?.label ?? binding.target.providerId}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
                    {t('upstreams.downstreams.boundKeysShort', { count: keyCount })}
                  </span>
                </button>
              );
            })}
            {!bindings.length && !draft ? (
              <div className="px-4 py-10 text-center">
                <Route className="mx-auto h-6 w-6 text-muted-foreground" />
                <p className="mt-2 text-xs text-muted-foreground">{t('upstreams.downstreams.empty')}</p>
                <Button className="mt-3" size="sm" onClick={beginCreate} disabled={!resources.length}>
                  <Plus className="h-3.5 w-3.5" />{t('upstreams.downstreams.add')}
                </Button>
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </aside>

      <main className="min-h-0 min-w-0 flex-1 overflow-hidden bg-surface-0/30">
        {!editorDraft ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {resources.length ? t('upstreams.downstreams.selectPrompt') : t('upstreams.downstreams.noResources')}
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="mx-auto max-w-4xl px-4 py-5 md:px-6 md:py-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    {editorDraft.id ? t('upstreams.downstreams.editEyebrow') : t('upstreams.downstreams.createEyebrow')}
                  </p>
                  <h2 className="mt-1 text-lg font-semibold text-foreground">
                    {editorDraft.name || t('upstreams.downstreams.untitled')}
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  {editorDraft.id ? (
                    <Button size="icon" variant="ghost" onClick={() => setDeleteTarget(selected)} aria-label={t('common.delete')}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  ) : null}
                  <Switch checked={editorDraft.enabled} onCheckedChange={(enabled) => patch({ enabled })} />
                </div>
              </div>

              <RouteRail draft={editorDraft} resource={selectedResource} t={t} />

              <div className="mt-6 divide-y divide-border/70 border-y border-border/70">
                <EditorSection title={t('upstreams.downstreams.sourceTitle')} description={t('upstreams.downstreams.sourceDescription')}>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t('upstreams.routes.name')}>
                      <Input value={editorDraft.name} onChange={(event) => patch({ name: event.target.value })} />
                    </Field>
                    <Field label={t('upstreams.routes.endpoint')}>
                      <Select className="w-full" value={editorDraft.endpoint} options={endpointOptions} onChange={(endpoint) => patch({ endpoint: endpoint as OutboundEndpointId })} />
                    </Field>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/70 bg-surface-1/45 px-3 py-2.5">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <KeyRound className="h-3.5 w-3.5 text-primary" />
                      {t('upstreams.downstreams.keyBindingHint', {
                        count: editorDraft.id
                          ? clientKeys.filter((key) => !key.revoked && selected && appliesToKey(selected, key.id)).length
                          : 0,
                      })}
                    </div>
                    <Button variant="ghost" size="sm" onClick={onOpenApiKeys}>
                      {t('upstreams.downstreams.manageKeys')}<ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </EditorSection>

                <EditorSection title={t('upstreams.downstreams.targetTitle')} description={t('upstreams.downstreams.targetDescription')}>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t('upstreams.downstreams.resource')}>
                      <Select className="w-full" value={editorDraft.resourceKey} options={resourceOptions} onChange={(resourceKey) => patch({ resourceKey })} />
                    </Field>
                    <Field label={t('upstreams.downstreams.egressProtocol')}>
                      <div className="flex h-9 items-center justify-between rounded-lg border border-border bg-surface-2/45 px-3 text-sm">
                        <span>{selectedResource?.egressProtocol ?? '—'}</span>
                        <Badge variant="secondary">{t('upstreams.downstreams.derived')}</Badge>
                      </div>
                    </Field>
                  </div>
                </EditorSection>

                <EditorSection title={t('upstreams.downstreams.modelTitle')} description={t('upstreams.downstreams.modelDescription')}>
                  <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-surface-1 p-1">
                    {(['passthrough', 'mapped'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={cn(
                          'flex min-h-9 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          editorDraft.modelMode === mode ? 'bg-surface-0 text-primary shadow-sm' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
                        )}
                        onClick={() => patch({
                          modelMode: mode,
                          mappings: mode === 'mapped' && editorDraft.mappings.length === 0
                            ? [{ source: '*', target: '' }]
                            : editorDraft.mappings,
                        })}
                      >
                        {mode === 'passthrough' ? <Cable className="h-3.5 w-3.5" /> : <Shuffle className="h-3.5 w-3.5" />}
                        {t(`upstreams.downstreams.modelMode.${mode}`)}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {t(`upstreams.downstreams.modelModeHint.${editorDraft.modelMode}`)}
                  </p>
                  {editorDraft.modelMode === 'mapped' ? (
                    <MappingEditor
                      mappings={editorDraft.mappings}
                      suggestions={selectedResource?.modelSuggestions ?? []}
                      onChange={(mappings) => patch({ mappings })}
                    />
                  ) : null}
                </EditorSection>

                <EditorSection title={t('upstreams.downstreams.failureTitle')} description={t('upstreams.downstreams.failureDescription')}>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t('upstreams.routes.priority')}>
                      <Input type="number" min={0} max={10_000} value={editorDraft.priority} onChange={(event) => patch({ priority: event.target.value })} />
                    </Field>
                    <Field label={t('upstreams.routes.fallbackLabel')}>
                      <Select className="w-full" value={editorDraft.fallback} options={fallbackOptions} onChange={(fallback) => patch({ fallback: fallback as GatewayBinding['fallback'] })} />
                    </Field>
                  </div>
                </EditorSection>
              </div>

              <div className="mt-4 flex justify-end gap-2">
                {draft ? <Button variant="outline" onClick={() => { setDraft(null); if (!selected) onSelectBinding(bindings[0]?.id); }}>{t('common.cancel')}</Button> : null}
                {selected && !draft ? (
                  <Button variant="outline" onClick={() => setDraft(draftFromBinding(selected, resources))}>
                    <Pencil className="h-3.5 w-3.5" />{t('common.edit')}
                  </Button>
                ) : null}
                <Button disabled={busy || !draft || !canSave(editorDraft)} onClick={() => void save()}>
                  <Check className="h-3.5 w-3.5" />{t('common.save')}
                </Button>
              </div>
            </div>
          </ScrollArea>
        )}
      </main>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t('upstreams.routes.deleteTitle')}
        description={deleteTarget ? t('upstreams.routes.deleteDescription', { name: deleteTarget.name }) : undefined}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        variant="destructive"
        onConfirm={() => void remove()}
      />
    </div>
  );
}

function RouteRail({
  draft,
  resource,
  t,
}: {
  draft: DownstreamDraft;
  resource?: DownstreamResourceOption;
  t: ReturnType<typeof useTranslation>;
}) {
  const nodes = [
    {
      icon: Cable,
      eyebrow: t('upstreams.downstreams.rail.ingress'),
      title: t(`apiService.endpoint.name.${draft.endpoint}`),
      detail: endpointPath(draft.endpoint),
      tone: 'border-emerald-500/35 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-400',
    },
    {
      icon: draft.modelMode === 'passthrough' ? Cable : Shuffle,
      eyebrow: t('upstreams.downstreams.rail.models'),
      title: t(`upstreams.downstreams.modelMode.${draft.modelMode}`),
      detail: draft.modelMode === 'passthrough'
        ? t('upstreams.downstreams.rail.noMapping')
        : t('upstreams.downstreams.rail.mappingCount', { count: draft.mappings.length }),
      tone: 'border-amber-500/35 bg-amber-500/[0.07] text-amber-700 dark:text-amber-400',
    },
    {
      icon: Server,
      eyebrow: t('upstreams.downstreams.rail.egress'),
      title: resource?.label ?? t('upstreams.downstreams.noResource'),
      detail: resource?.egressProtocol ?? '—',
      tone: 'border-sky-500/35 bg-sky-500/[0.06] text-sky-700 dark:text-sky-400',
    },
  ];
  return (
    <div className="mt-4 grid items-stretch gap-2 md:grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)_28px_minmax(0,1fr)]">
      {nodes.map(({ icon: Icon, eyebrow, title, detail, tone }, index) => (
        <React.Fragment key={eyebrow}>
          {index > 0 ? <div className="flex items-center justify-center text-muted-foreground"><ArrowRight className="h-4 w-4" /></div> : null}
          <div className={cn('min-w-0 rounded-lg border p-3', tone)}>
            <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.08em]">
              <Icon className="h-3.5 w-3.5" />{eyebrow}
            </div>
            <p className="mt-2 truncate text-xs font-semibold text-foreground">{title}</p>
            <p className="mt-1 truncate font-mono text-[9px] text-muted-foreground">{detail}</p>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

function MappingEditor({
  mappings,
  suggestions,
  onChange,
}: {
  mappings: MappingDraft[];
  suggestions: string[];
  onChange: (mappings: MappingDraft[]) => void;
}) {
  const t = useTranslation();
  const listId = 'downstream-model-suggestions';
  const patch = (index: number, next: Partial<GatewayModelMapping>) => {
    onChange(mappings.map((mapping, itemIndex) => itemIndex === index ? { ...mapping, ...next } : mapping));
  };
  return (
    <div className="mt-3 space-y-2">
      <datalist id={listId}>{suggestions.map((model) => <option key={model} value={model} />)}</datalist>
      <div className="hidden grid-cols-[minmax(0,1fr)_20px_minmax(0,1fr)_32px] gap-2 px-1 font-mono text-[9px] uppercase text-muted-foreground sm:grid">
        <span>{t('upstreams.downstreams.mapping.source')}</span><span />
        <span>{t('upstreams.downstreams.mapping.target')}</span><span />
      </div>
      {mappings.map((mapping, index) => (
        <div key={index} className="grid grid-cols-[minmax(0,1fr)_20px_minmax(0,1fr)_32px] items-center gap-2">
          <Input value={mapping.source} placeholder="claude-sonnet-*" onChange={(event) => patch(index, { source: event.target.value })} />
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
          <Input list={listId} value={mapping.target} placeholder="glm-4.7" onChange={(event) => patch(index, { target: event.target.value })} />
          <Button size="icon" variant="ghost" onClick={() => onChange(mappings.filter((_, itemIndex) => itemIndex !== index))} aria-label={t('common.delete')}>
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      ))}
      <Button size="sm" variant="outline" onClick={() => onChange([...mappings, { source: '', target: '' }])}>
        <Plus className="h-3.5 w-3.5" />{t('upstreams.downstreams.mapping.add')}
      </Button>
    </div>
  );
}

function EditorSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4 py-5 md:grid-cols-[150px_minmax(0,1fr)]">
      <div><h3 className="text-xs font-semibold text-foreground">{title}</h3><p className="mt-1 text-[10px] leading-4 text-muted-foreground">{description}</p></div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block min-w-0"><span className="mb-1.5 block text-xs font-medium text-foreground">{label}</span>{children}</label>;
}

function endpointPath(endpoint: OutboundEndpointId): string {
  if (endpoint === 'messages') return '/v1/messages';
  if (endpoint === 'responses') return '/v1/responses';
  if (endpoint === 'chat') return '/v1/chat/completions';
  return '/v1beta/models/{model}:generateContent';
}
