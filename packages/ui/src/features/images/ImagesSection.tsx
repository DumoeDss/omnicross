import { ArrowRight, Image, Route } from 'lucide-react';
import React, { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Select, type SelectOption } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { ImagesServerConfig, SubscriptionAccountSanitized } from '@/daemon/types';
import { useTranslation } from '@/shared/state/LocaleContext';
import type { LLMProvider } from '@shared/llm-config';

import {
  CODEX_IMAGE_MODELS,
  DEFAULT_CODEX_IMAGE_MODEL,
  configureCodexImageRoute,
  imageProviderModels,
  preferredImageModel,
} from './imageProviderConfigModel';

export function imageAccountSelection(config: ImagesServerConfig): string {
  if (config.account.id) return `account:${config.account.id}`;
  if (config.account.group) return `group:${config.account.group}`;
  return 'pool';
}

export function applyImageAccountSelection(config: ImagesServerConfig, selection: string): ImagesServerConfig {
  const account = selection.startsWith('account:')
    ? { id: selection.slice('account:'.length), fallback: config.account.fallback }
    : selection.startsWith('group:')
      ? { group: selection.slice('group:'.length), fallback: config.account.fallback }
      : { fallback: config.account.fallback };
  return { ...config, account };
}

export function ImagesSection({ config, accounts, antigravityAccounts = [], sources = [], busy, onUpdate }: {
  config: ImagesServerConfig;
  accounts: SubscriptionAccountSanitized[];
  antigravityAccounts?: SubscriptionAccountSanitized[];
  sources?: LLMProvider[];
  busy: boolean;
  onUpdate: (config: ImagesServerConfig) => Promise<void>;
}) {
  const t = useTranslation();
  const initialProvider = config.models[config.defaultModel] ?? 'codex-subscription';
  const initialModel = initialProvider === 'codex-subscription' ? config.codex.imageModel
    : config.providers?.[initialProvider]?.modelMap?.[config.defaultModel] ?? config.defaultModel;
  const [enabled, setEnabled] = useState(config.enabled);
  const [providerId, setProviderId] = useState(initialProvider);
  const [model, setModel] = useState(initialModel);
  const [selection, setSelection] = useState(imageAccountSelection(config));
  const [fallback, setFallback] = useState(config.account.fallback);
  const [mappings, setMappings] = useState<Record<string, string>>(() => Object.fromEntries(CODEX_IMAGE_MODELS.map((requested) => [requested,
    config.providers?.[initialProvider]?.modelMap?.[requested] ?? config.providers?.[initialProvider]?.modelAliases?.[requested] ?? config.aliases[requested]
      ?? preferredImageModel(imageProviderModels(config, initialProvider), requested, initialModel),
  ])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = busy || saving;

  function modelsFor(id: string): string[] {
    if (id === 'codex-subscription') return [...CODEX_IMAGE_MODELS];
    const models = imageProviderModels(config, id);
    return id === 'antigravity-subscription'
      ? [...new Set([...models, 'gemini-nano-banana-2.1', 'gemini-3-pro-image'])] : models;
  }
  const availableModels = modelsFor(providerId);
  const modelOptions = [...new Set([...availableModels, ...(model ? [model] : [])])].map((value) => ({ value, label: value }));
  const providerOptions: SelectOption[] = [
    { value: 'codex-subscription', label: t('images.routing.codexSubscription') },
    { value: 'antigravity-subscription', label: t('images.routing.antigravitySubscription') },
    ...Object.entries(config.providers ?? {}).map(([id, instance]) => {
      const source = sources.find((entry) => entry.id === instance.sourceProviderId);
      return { value: id, label: source?.name || id, disabled: instance.enabled === false || source?.enabled === false };
    }),
  ];
  const providerLabel = providerOptions.find((entry) => entry.value === providerId)?.label;
  const subscription = providerId === 'codex-subscription' || providerId === 'antigravity-subscription';
  const providerAccounts = providerId === 'antigravity-subscription' ? antigravityAccounts : accounts;
  const groups = [...new Set(providerAccounts.map((account) => account.group).filter(Boolean))];
  const accountOptions: SelectOption[] = [
    { value: 'pool', label: t('images.account.pool') },
    ...groups.map((group) => ({ value: `group:${group}`, label: t('images.account.group', { group }) })),
    ...providerAccounts.map((account, index) => ({ value: `account:${account.id}`,
      label: account.label || t('images.account.account', { number: index + 1 }), disabled: !account.enabled || !account.schedulable })),
  ];

  function changeProvider(id: string) {
    const models = modelsFor(id);
    const preferred = config.providers?.[id]?.modelAliases?.[DEFAULT_CODEX_IMAGE_MODEL] ?? preferredImageModel(models);
    setProviderId(id); setModel(preferred); setSelection('pool');
    setMappings(Object.fromEntries(CODEX_IMAGE_MODELS.map((requested) => [requested, config.providers?.[id]?.modelAliases?.[requested] ?? preferredImageModel(models, requested, preferred)])));
  }
  async function save() {
    setSaving(true); setError(null);
    try {
      let next = configureCodexImageRoute(config, providerId, model, mappings);
      next = { ...next, enabled };
      if (subscription) next = applyImageAccountSelection({ ...next, account: { ...next.account, fallback } }, selection);
      await onUpdate(next);
    } catch (err) { setError(err instanceof Error ? t(err.message) : String(err)); }
    finally { setSaving(false); }
  }
  return (
    <section className="space-y-5 rounded-xl border border-border/70 bg-surface-1/50 p-5" data-testid="codex-image-routing">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10"><Image className="h-4 w-4 text-primary" aria-hidden="true" /></span>
          <div><h3 className="text-sm font-semibold">{t('images.routing.title')}</h3><p className="mt-1 text-xs text-muted-foreground">{t('images.routing.description')}</p></div>
        </div>
        <Switch checked={enabled} disabled={disabled} onCheckedChange={setEnabled} aria-label={t('images.enable')} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label htmlFor="codex-image-provider" className="space-y-1.5 text-xs"><span className="font-medium">{t('images.routing.provider')}</span>
          <Select id="codex-image-provider" value={providerId} options={providerOptions} disabled={disabled} onChange={changeProvider} />
        </label>
        <label htmlFor="codex-image-model" className="space-y-1.5 text-xs"><span className="font-medium">{t('images.routing.model')}</span>
          <Select id="codex-image-model" value={model} options={modelOptions} disabled={disabled || !modelOptions.length} onChange={(value) => {
            setModel(value); setMappings(Object.fromEntries(CODEX_IMAGE_MODELS.map((requested) => [requested, value])));
          }} />
        </label>
      </div>
      {!availableModels.length ? <p className="text-xs text-muted-foreground">{t('images.models.empty')}</p> : null}
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-0/80 px-3 py-3 text-xs" data-testid="codex-image-route-preview">
        <Route className="h-4 w-4 text-primary" aria-hidden="true" /><span>Codex</span><ArrowRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" /><span>{providerLabel}</span><ArrowRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" /><code className="break-all">{model || DEFAULT_CODEX_IMAGE_MODEL}</code>
      </div>
      {providerId !== 'codex-subscription' ? <div className="space-y-3" data-testid="codex-image-model-mapping">
        <p className="text-xs text-muted-foreground">{t('images.routing.mappingHint')}</p>
        <div className="grid gap-2">
          {CODEX_IMAGE_MODELS.map((requested) => <label key={requested} htmlFor={`image-mapping-${requested}`} className="grid items-center gap-2 text-xs sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,2fr)]">
            <code>{requested}</code><ArrowRight className="hidden h-3 w-3 text-muted-foreground sm:block" aria-hidden="true" />
            <Select id={`image-mapping-${requested}`} value={mappings[requested] ?? model} options={modelOptions} disabled={disabled || !modelOptions.length} onChange={(value) => {
              setMappings({ ...mappings, [requested]: value });
              if (requested === DEFAULT_CODEX_IMAGE_MODEL) setModel(value);
            }} />
          </label>)}
        </div>
      </div> : null}
      {subscription ? <div className="grid gap-4 border-t border-border/60 pt-4 sm:grid-cols-2">
        <label className="space-y-1.5 text-xs"><span>{t('images.account.label')}</span><Select aria-label={t('images.account.label')} value={selection} options={accountOptions} disabled={disabled} onChange={setSelection} /></label>
        <label className="space-y-1.5 text-xs"><span>{t('images.account.fallback')}</span><Select value={fallback} options={[{ value: 'strict', label: t('images.account.strict') }, { value: 'pool', label: t('images.account.poolFallback') }]} disabled={disabled} onChange={(value) => setFallback(value as 'strict' | 'pool')} /></label>
      </div> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <Button type="button" size="sm" disabled={disabled || !model} onClick={() => void save()}>{t('images.api.save')}</Button>
    </section>
  );
}
