import { Download, Plus, Trash2 } from 'lucide-react';
import React, { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ImagesServerConfig } from '@/daemon/types';
import { agent } from '@/shared/agent';
import { useTranslation } from '@/shared/state/LocaleContext';

import { saveImageProviderModels } from './imageProviderConfigModel';
import { IMAGE_PROVIDER_TEMPLATES, imageProviderModelsText } from './imageProviderTemplates';

interface ModelRow { model: string; upstream: string }
function rowsFromText(text: string): ModelRow[] {
  return text.split('\n').filter(Boolean).map((line) => {
    const [model, upstream] = line.split('=').map((value) => value.trim());
    return { model: model!, upstream: upstream ?? model! };
  });
}

export function ImageProviderModels({ id, config, busy, onUpdate }: {
  id: string;
  config: ImagesServerConfig;
  busy: boolean;
  onUpdate: (config: ImagesServerConfig) => Promise<void>;
}) {
  const t = useTranslation();
  const instance = config.providers![id]!;
  const [rows, setRows] = useState(() => rowsFromText(imageProviderModelsText(config, id)));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = busy || pending;
  const template = IMAGE_PROVIDER_TEMPLATES.find((value) => value.protocol === instance.protocol);
  const canDiscover = ['openai-images', 'xai', 'openrouter'].includes(instance.protocol);

  function addModels(models: readonly string[]) {
    setRows((current) => [...current, ...models.filter((model) => !current.some((row) => row.upstream === model))
      .map((model) => ({ model, upstream: model }))]);
  }
  async function discover() {
    setPending(true); setError(null);
    try {
      const result = await agent.llmConfig.discoverModels(instance.sourceProviderId, { forceRefresh: true });
      if (!result.success) throw new Error(result.error || t('images.models.fetchFailed'));
      const models = result.models.map((model) => model.id).filter((model) => /image|imagen|dall-e|nano-banana|seedream|flux|recraft|ideogram|stable-diffusion/iu.test(model));
      if (!models.length) throw new Error(t('images.models.noImages'));
      addModels(models);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setPending(false); }
  }
  async function save() {
    setPending(true); setError(null);
    try {
      await onUpdate(saveImageProviderModels(config, id, rows));
    } catch (err) { setError(err instanceof Error ? t(err.message) : String(err)); }
    finally { setPending(false); }
  }
  return (
    <section className="space-y-4 rounded-xl border border-border/70 bg-surface-1/50 p-4" data-testid="image-provider-models">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{t('images.models.title')}</h3>
        <div className="flex flex-wrap gap-2">
          {canDiscover ? <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => void discover()}><Download className="mr-1.5 h-3.5 w-3.5" />{t('images.models.fetch')}</Button> : null}
          {template?.models.length ? <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => addModels(template.models)}>{t('images.models.template')}</Button> : null}
          <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setRows([...rows, { model: '', upstream: '' }])}><Plus className="mr-1.5 h-3.5 w-3.5" />{t('images.models.add')}</Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('images.models.hint')}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-96 text-left text-xs">
          <thead><tr className="border-b border-border/60 text-muted-foreground"><th className="pb-2 pr-3 font-medium">{t('images.models.upstream')}</th><th className="pb-2 pr-3 font-medium">{t('images.models.request')}</th><th /></tr></thead>
          <tbody>{rows.map((row, index) => <tr key={index}>
            <td className="py-2 pr-3"><Input aria-label={`${t('images.models.upstream')} ${index + 1}`} className="font-mono text-xs" disabled={disabled} value={row.upstream} onChange={(event) => {
              const value = event.target.value;
              setRows(rows.map((entry, i) => i === index ? { upstream: value, model: entry.model === entry.upstream ? value : entry.model } : entry));
            }} /></td>
            <td className="py-2 pr-3"><Input aria-label={`${t('images.models.request')} ${index + 1}`} className="font-mono text-xs" disabled={disabled} value={row.model} placeholder={row.upstream} onChange={(event) => {
              setRows(rows.map((entry, i) => i === index ? { ...entry, model: event.target.value } : entry));
            }} /></td>
            <td><Button type="button" size="icon" variant="ghost" disabled={disabled} aria-label={`${t('images.api.remove')} ${index + 1}`} onClick={() => setRows(rows.filter((_, i) => i !== index))}><Trash2 className="h-3.5 w-3.5" /></Button></td>
          </tr>)}</tbody>
        </table>
      </div>
      {!rows.length ? <p className="py-4 text-xs text-muted-foreground">{t('images.models.empty')}</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <Button type="button" size="sm" disabled={disabled} onClick={() => void save()}>{t('images.api.save')}</Button>
    </section>
  );
}
