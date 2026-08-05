import {
  ArrowRight,
  Cable,
  KeyRound,
  Pencil,
  Plus,
  Route,
  Trash2,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type {
  GatewayBinding,
  GatewayBindingTarget,
  OutboundApiKeyInfo,
  OutboundEndpointId,
} from '@/daemon/types';
import { useTranslation } from '@/shared/state/LocaleContext';

import { modelKindsForEndpoint } from '../api-service/endpointKinds';
import {
  bindingDraftFromBinding,
  bindingFromDraft,
  bindingMatchesTarget,
  bindingModelSummary,
  canSaveBindingDraft,
  type BindingDraft,
  newBindingDraft,
} from './upstreamBindingModel';

export interface ProviderPoolKeyOption {
  id: string;
  label: string;
  enabled: boolean;
}

interface ResourceBindingsPanelProps {
  target: GatewayBindingTarget;
  resourceName: string;
  bindings: GatewayBinding[];
  clientKeys: OutboundApiKeyInfo[];
  modelIds: string[];
  providerKeys?: ProviderPoolKeyOption[];
  busy: boolean;
  onChange: (bindings: GatewayBinding[]) => Promise<void> | void;
}

const ENDPOINT_OPTIONS: OutboundEndpointId[] = ['messages', 'responses', 'chat', 'gemini'];

export function ResourceBindingsPanel({
  target,
  resourceName,
  bindings,
  clientKeys,
  modelIds,
  providerKeys = [],
  busy,
  onChange,
}: ResourceBindingsPanelProps) {
  const t = useTranslation();
  const [draft, setDraft] = useState<BindingDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GatewayBinding | null>(null);
  const resourceBindings = useMemo(
    () => bindings.filter((binding) => bindingMatchesTarget(binding, target)),
    [bindings, target],
  );

  const save = async () => {
    if (!draft || !canSaveBindingDraft(draft)) return;
    const nextBinding = bindingFromDraft(draft, target);
    const next = bindings.some((binding) => binding.id === nextBinding.id)
      ? bindings.map((binding) => binding.id === nextBinding.id ? nextBinding : binding)
      : [...bindings, nextBinding];
    await onChange(next);
    setDraft(null);
  };

  const remove = async () => {
    if (!deleteTarget) return;
    await onChange(bindings.filter((binding) => binding.id !== deleteTarget.id));
    setDeleteTarget(null);
  };

  return (
    <section className="space-y-3" data-testid="resource-bindings-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Route className="h-4 w-4 text-primary" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-foreground">{t('upstreams.routes.title')}</h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('upstreams.routes.description')}</p>
        </div>
        <Button size="sm" disabled={busy} onClick={() => setDraft(newBindingDraft())}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {t('upstreams.routes.add')}
        </Button>
      </div>

      {resourceBindings.length ? (
        <div className="space-y-2">
          {resourceBindings.map((binding) => (
            <article key={binding.id} className="rounded-lg border border-border/70 bg-surface-0/70 p-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{binding.name}</span>
                    <Badge variant={binding.enabled ? 'success' : 'secondary'}>
                      {binding.enabled ? t('upstreams.routes.enabled') : t('upstreams.routes.disabled')}
                    </Badge>
                    <Badge variant="outline">{t(`apiService.endpoint.name.${binding.endpoint}`)}</Badge>
                  </div>
                  <SignalPath
                    keyLabel={binding.apiKeyIds?.length
                      ? binding.apiKeyIds.map((id) => clientKeys.find((key) => key.id === id)?.name ?? id).join(', ')
                      : t('upstreams.routes.allClientKeys')}
                    endpoint={t(`apiService.endpoint.name.${binding.endpoint}`)}
                    resource={resourceName}
                    model={bindingModelSummary(binding) || t('upstreams.routes.unconfiguredModel')}
                  />
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {t('upstreams.routes.priorityFallback', {
                      priority: binding.priority ?? 100,
                      fallback: t(`upstreams.routes.fallback.${binding.fallback}`),
                    })}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="icon" variant="ghost" onClick={() => setDraft(bindingDraftFromBinding(binding))} aria-label={t('common.edit')}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => setDeleteTarget(binding)} aria-label={t('common.delete')}>
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border/70 px-4 py-8 text-center">
          <Cable className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">{t('upstreams.routes.empty')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('upstreams.routes.emptyHint')}</p>
        </div>
      )}

      <BindingEditorDialog
        draft={draft}
        clientKeys={clientKeys.filter((key) => !key.revoked)}
        modelIds={modelIds}
        providerKeys={target.kind === 'provider' ? providerKeys : []}
        busy={busy}
        onChange={setDraft}
        onSave={() => void save()}
        onClose={() => setDraft(null)}
      />

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
    </section>
  );
}

function SignalPath({ keyLabel, endpoint, resource, model }: { keyLabel: string; endpoint: string; resource: string; model: string }) {
  const t = useTranslation();
  const cells = [
    { icon: KeyRound, value: keyLabel },
    { icon: Cable, value: endpoint },
    { icon: Route, value: resource },
    { icon: ArrowRight, value: model },
  ];
  return (
    <div
      className="mt-3 flex items-center gap-1 overflow-x-auto"
      aria-label={t('upstreams.routes.signalPath', { key: keyLabel, endpoint, resource, model })}
    >
      {cells.map(({ icon: Icon, value }, index) => (
        <React.Fragment key={`${index}:${value}`}>
          {index > 0 ? <ArrowRight className="h-3 w-3 shrink-0 text-primary/60" aria-hidden="true" /> : null}
          <span className="inline-flex max-w-44 shrink-0 items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2 py-1 text-[11px] text-foreground">
            <Icon className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
            <span className="truncate">{value}</span>
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

function BindingEditorDialog({
  draft,
  clientKeys,
  modelIds,
  providerKeys,
  busy,
  onChange,
  onSave,
  onClose,
}: {
  draft: BindingDraft | null;
  clientKeys: OutboundApiKeyInfo[];
  modelIds: string[];
  providerKeys: ProviderPoolKeyOption[];
  busy: boolean;
  onChange: (draft: BindingDraft | null) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const t = useTranslation();
  if (!draft) return null;
  const patch = (next: Partial<BindingDraft>) => onChange({ ...draft, ...next });
  const endpointOptions: SelectOption[] = ENDPOINT_OPTIONS.map((endpoint) => ({
    value: endpoint,
    label: t(`apiService.endpoint.name.${endpoint}`),
  }));
  const fallbackOptions: SelectOption[] = [
    { value: 'fail', label: t('upstreams.routes.fallback.fail') },
    { value: 'global', label: t('upstreams.routes.fallback.global') },
  ];
  const providerKeyOptions: SelectOption[] = [
    { value: '', label: t('upstreams.routes.providerKeyPool') },
    ...providerKeys.map((key) => ({
      value: key.id,
      label: key.enabled ? key.label : `${key.label} · ${t('upstreams.routes.disabled')}`,
    })),
  ];

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{draft.id ? t('upstreams.routes.editTitle') : t('upstreams.routes.createTitle')}</DialogTitle>
          <DialogDescription>{t('upstreams.routes.editorDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Labeled label={t('upstreams.routes.name')}>
              <Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
            </Labeled>
            <Labeled label={t('upstreams.routes.endpoint')}>
              <Select value={draft.endpoint} options={endpointOptions} onChange={(value) => patch({ endpoint: value as OutboundEndpointId, modelMap: {} })} />
            </Labeled>
            <Labeled label={t('upstreams.routes.priority')}>
              <Input type="number" min={0} max={10_000} value={draft.priority} onChange={(event) => patch({ priority: event.target.value })} />
            </Labeled>
            <Labeled label={t('upstreams.routes.fallbackLabel')}>
              <Select value={draft.fallback} options={fallbackOptions} onChange={(value) => patch({ fallback: value as GatewayBinding['fallback'] })} />
            </Labeled>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border/70 p-3">
            <div>
              <p className="text-sm font-medium">{t('upstreams.routes.enabled')}</p>
              <p className="text-xs text-muted-foreground">{t('upstreams.routes.enabledHint')}</p>
            </div>
            <Switch checked={draft.enabled} onCheckedChange={(enabled) => patch({ enabled })} />
          </div>

          <fieldset className="space-y-2 rounded-lg border border-border/70 p-3">
            <legend className="px-1 text-xs font-medium text-muted-foreground">{t('upstreams.routes.clientKeyScope')}</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.apiKeyIds.length === 0} onChange={() => patch({ apiKeyIds: [] })} />
              {t('upstreams.routes.allClientKeys')}
            </label>
            {clientKeys.map((key) => (
              <label key={key.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.apiKeyIds.includes(key.id)}
                  onChange={(event) => patch({
                    apiKeyIds: event.target.checked
                      ? [...draft.apiKeyIds, key.id]
                      : draft.apiKeyIds.filter((id) => id !== key.id),
                  })}
                />
                <span>{key.name}</span>
                <code className="text-xs text-muted-foreground">{key.keyPrefix}…</code>
              </label>
            ))}
          </fieldset>

          {providerKeys.length ? (
            <Labeled label={t('upstreams.routes.providerKey')} hint={t('upstreams.routes.providerKeyHint')}>
              <Select value={draft.providerKeyId} options={providerKeyOptions} onChange={(providerKeyId) => patch({ providerKeyId })} />
            </Labeled>
          ) : null}

          <ModelFields draft={draft} modelIds={modelIds} onChange={patch} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={busy || !canSaveBindingDraft(draft)} onClick={onSave}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModelFields({ draft, modelIds, onChange }: { draft: BindingDraft; modelIds: string[]; onChange: (patch: Partial<BindingDraft>) => void }) {
  const t = useTranslation();
  const listId = `binding-models-${draft.id ?? 'new'}`;
  if (draft.endpoint === 'messages' || draft.endpoint === 'responses') {
    return (
      <fieldset className="space-y-3 rounded-lg border border-border/70 p-3">
        <legend className="px-1 text-xs font-medium text-muted-foreground">{t('upstreams.routes.modelMapping')}</legend>
        <datalist id={listId}>{modelIds.map((model) => <option key={model} value={model} />)}</datalist>
        <div className="grid gap-3 sm:grid-cols-2">
          {modelKindsForEndpoint(draft.endpoint).map((kind) => (
            <Labeled key={kind} label={t(`apiService.endpoint.kind.${kind}`)}>
              <Input list={listId} value={draft.modelMap[kind] ?? ''} onChange={(event) => onChange({ modelMap: { ...draft.modelMap, [kind]: event.target.value } })} />
            </Labeled>
          ))}
        </div>
      </fieldset>
    );
  }
  if (draft.endpoint === 'chat') {
    return (
      <Labeled label={t('upstreams.routes.models')} hint={t('upstreams.routes.modelsHint')}>
        <textarea className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={draft.modelsText} onChange={(event) => onChange({ modelsText: event.target.value })} />
      </Labeled>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <datalist id={listId}>{modelIds.map((model) => <option key={model} value={model} />)}</datalist>
      <Labeled label={t('apiService.endpoint.defaultModel')}>
        <Input list={listId} value={draft.defaultModel} onChange={(event) => onChange({ defaultModel: event.target.value })} />
      </Labeled>
      <Labeled label={t('apiService.endpoint.backgroundModel')}>
        <Input list={listId} value={draft.backgroundModel} onChange={(event) => onChange({ backgroundModel: event.target.value })} />
      </Labeled>
      <div className="sm:col-span-2">
        <Labeled label={t('apiService.endpoint.backgroundModelIds')}>
          <Input value={draft.backgroundModelIdsText} onChange={(event) => onChange({ backgroundModelIdsText: event.target.value })} />
        </Labeled>
      </div>
    </div>
  );
}

function Labeled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5 text-sm">
      <span className="font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
