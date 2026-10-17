import React, { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { LLMProvider } from '@shared/llm-config';
import type { ImageApiProtocol, ImagesServerConfig } from '@/daemon/types';
import { agent } from '@/shared/agent';
import { useTranslation } from '@/shared/state/LocaleContext';

import { ImageCredentialForm } from './ImageCredentialForm';
import { ImageAliasesForm } from './ImageAliasesForm';
import { removeImageInstance, saveImageInstance } from './imageProviderConfigModel';

const PROTOCOLS: ImageApiProtocol[] = ['openai-images', 'gemini', 'gemini-interactions', 'vertex', 'xai', 'openrouter', 'wavespeed'];
const EXAMPLES: Record<ImageApiProtocol, string> = {
  'openai-images': 'gpt-image-2.5-flare\ngpt-image-2.5-sunburst',
  gemini: 'gemini-nano-banana-2.1\ngemini-3.1-flash-lite-image\ngemini-3-pro-image',
  'gemini-interactions': 'gemini-nano-banana-2.1',
  vertex: 'gemini-3-pro-image', xai: 'grok-imagine-image',
  openrouter: 'nano-banana = google/gemini-nano-banana-2.1',
  wavespeed: 'gpt-image-2.5-sunburst = openai/gpt-image-2.5-sunburst/text-to-image\nz-image = wavespeed-ai/z-image/turbo',
};

export function ImageApiProvidersPanel({ config, busy, onUpdate }: {
  config: ImagesServerConfig; busy: boolean; onUpdate: (config: ImagesServerConfig) => Promise<void>;
}) {
  const t = useTranslation();
  const [sources, setSources] = useState<LLMProvider[]>([]);
  const [editing, setEditing] = useState(false);
  const [existing, setExisting] = useState(false);
  const [id, setId] = useState('');
  const [protocol, setProtocol] = useState<ImageApiProtocol>('openai-images');
  const [sourceId, setSourceId] = useState('');
  const [models, setModels] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [credentialMode, setCredentialMode] = useState<'new' | 'edit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void agent.llmConfig.getProviders().then((values) => { if (!cancelled) setSources(values); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, []);
  function open(instanceId?: string) {
    const value = instanceId ? config.providers?.[instanceId] : undefined;
    setId(instanceId ?? ''); setExisting(Boolean(value));
    setProtocol(value?.protocol ?? 'openai-images'); setSourceId(value?.sourceProviderId ?? '');
    setEnabled(value?.enabled !== false);
    setModels(value ? Object.entries(config.models).filter(([, provider]) => provider === instanceId)
      .map(([model]) => value.modelMap?.[model] && value.modelMap[model] !== model ? `${model} = ${value.modelMap[model]}` : model).join('\n') : '');
    setError(null); setEditing(true); setCredentialMode(null);
  }
  async function persist(next: ImagesServerConfig) { await onUpdate(next); setEditing(false); }
  async function save() {
    setError(null);
    try {
      if (!existing && config.providers?.[id.trim()]) throw new Error('images.api.duplicateInstance');
      await persist(saveImageInstance(config, id.trim(), { protocol, sourceProviderId: sourceId, enabled }, models));
    } catch (err) { setError(err instanceof Error ? t(err.message) : String(err)); }
  }
  return <section className="space-y-4 rounded-xl border border-border/70 bg-surface-1/50 p-4" data-testid="image-api-providers">
    <div className="flex items-start justify-between gap-3">
      <div><h3 className="text-sm font-semibold">{t('images.api.title')}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('images.api.description')}</p></div>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => open()}>{t('images.api.add')}</Button>
    </div>
    {Object.entries(config.providers ?? {}).map(([instanceId, value]) => <div key={instanceId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs">
      <div><p className="font-medium">{instanceId} · {value.protocol}</p>
        <p className="mt-1 text-muted-foreground">{sources.find((source) => source.id === value.sourceProviderId)?.name ?? value.sourceProviderId} · {t(value.enabled === false ? 'images.track.off' : 'images.track.on')}</p></div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => open(instanceId)}>{t('images.api.edit')}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => {
          setError(null);
          try { void persist(removeImageInstance(config, instanceId)).catch(() => undefined); }
          catch (err) { setError(err instanceof Error ? t(err.message) : String(err)); }
        }}>{t('images.api.remove')}</Button>
      </div>
    </div>)}
    {!Object.keys(config.providers ?? {}).length && !editing ? <p className="text-xs text-muted-foreground">{t('images.api.empty')}</p> : null}
    {editing ? <div className="space-y-3 border-t border-border/60 pt-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs">{t('images.api.instanceId')}
          <Input value={id} disabled={busy || existing} onChange={(event) => setId(event.target.value)} placeholder="my-images" /></label>
        <label className="space-y-1 text-xs">{t('images.api.protocol')}
          <Select value={protocol} disabled={busy} options={PROTOCOLS.map((value) => ({ value, label: value }))}
            onChange={(value) => setProtocol(value as ImageApiProtocol)} /></label>
      </div>
      <label className="block space-y-1 text-xs">{t('images.api.source')}
        <Select value={sourceId} disabled={busy} options={[{ value: '', label: t('images.api.selectSource') },
          ...sources.map((source) => ({ value: source.id, label: source.name || source.id }))]} onChange={setSourceId} /></label>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setCredentialMode('new')}>{t('images.api.newCredentials')}</Button>
        <Button size="sm" variant="outline" disabled={busy || !sources.some((source) => source.id === sourceId)} onClick={() => setCredentialMode('edit')}>{t('images.api.editCredentials')}</Button>
      </div>
      {credentialMode ? <ImageCredentialForm key={`${credentialMode}:${sourceId}`}
        source={credentialMode === 'edit' ? sources.find((source) => source.id === sourceId) : undefined}
        onCancel={() => setCredentialMode(null)} onSaved={async (savedId) => {
          setSources(await agent.llmConfig.getProviders()); setSourceId(savedId); setCredentialMode(null);
        }} /> : null}
      <label className="block space-y-1 text-xs">{t('images.api.models')}
        <textarea className="min-h-28 w-full rounded-md border border-border bg-surface-0 p-2 font-mono text-xs" value={models}
          placeholder={EXAMPLES[protocol]} disabled={busy} onChange={(event) => setModels(event.target.value)} /></label>
      <p className="text-xs text-muted-foreground">{t('images.api.modelsHint')}</p>
      <label className="flex items-center gap-2 text-xs"><Switch checked={enabled} disabled={busy} onCheckedChange={setEnabled} />{t('images.track.on')}</label>
      <div className="flex gap-2"><Button size="sm" disabled={busy || credentialMode !== null} onClick={() => void save()}>{t('images.api.save')}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(false)}>{t('images.api.cancel')}</Button></div>
    </div> : null}
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    <ImageAliasesForm config={config} busy={busy} onUpdate={onUpdate} />
    <p className="text-xs text-muted-foreground">{t('images.api.verificationHint')}</p>
  </section>;
}
