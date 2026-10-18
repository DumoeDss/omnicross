import React, { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { ImageApiProtocol, ImagesServerConfig } from '@/daemon/types';
import { agent } from '@/shared/agent';
import { useTranslation } from '@/shared/state/LocaleContext';
import type { LLMProvider } from '@shared/llm-config';

import { imageProviderModels, saveImageProvider } from './imageProviderConfigModel';
import {
  IMAGE_PROVIDER_TEMPLATES,
  nextImageProviderId,
  type ImageProviderTemplate,
} from './imageProviderTemplates';

interface ImageProviderFormProps {
  config: ImagesServerConfig;
  sources: LLMProvider[];
  template: ImageProviderTemplate;
  existingId?: string;
  busy: boolean;
  onUpdate: (config: ImagesServerConfig) => Promise<void>;
  onCredentialsChanged: () => Promise<void>;
  onSaved: (id: string) => void;
  onCancel: () => void;
}

export function ImageProviderForm({ config, sources, template, existingId, busy,
  onUpdate, onCredentialsChanged, onSaved, onCancel }: ImageProviderFormProps) {
  const t = useTranslation();
  const existing = existingId ? config.providers?.[existingId] : undefined;
  const [id, setId] = useState(existingId ?? nextImageProviderId(config, template));
  const [protocol, setProtocol] = useState<ImageApiProtocol>(existing?.protocol ?? template.protocol);
  const [enabled, setEnabled] = useState(existing?.enabled !== false);
  const [credentialMode, setCredentialMode] = useState(existing ? 'saved' : 'new');
  const [sourceId, setSourceId] = useState(existing?.sourceProviderId ?? '');
  const [name, setName] = useState(template.name);
  const [baseUrl, setBaseUrl] = useState(template.baseUrl);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A config failure must not create another credential row on retry.
  const createdSource = useRef<{ id: string; name: string; baseUrl: string } | null>(null);
  const disabled = busy || saving;

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const instanceId = id.trim();
      if (!existingId && Object.prototype.hasOwnProperty.call(config.providers ?? {}, instanceId)) {
        throw new Error('images.api.duplicateInstance');
      }
      const selectedTemplate = IMAGE_PROVIDER_TEMPLATES.find((value) => value.protocol === protocol) ?? template;
      const instance = { ...existing, protocol, sourceProviderId: credentialMode === 'new' ? 'pending' : sourceId, enabled,
        models: existing ? imageProviderModels(config, existingId!) : [...(protocol === template.protocol ? template : selectedTemplate).models],
        ...(existing && !existing.modelAliases ? { modelAliases: Object.fromEntries(Object.entries(existing.modelMap ?? {}).filter(([model, upstream]) => model !== upstream)) } : {}),
      };
      let next = saveImageProvider(config, instanceId, instance);
      if (credentialMode === 'new') {
        let url: URL;
        try { url = new URL(baseUrl.trim()); } catch { throw new Error('images.api.invalidUrl'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
          throw new Error('images.api.invalidUrl');
        }
        const saved = createdSource.current;
        if (saved && (saved.name !== name.trim() || saved.baseUrl !== url.href || key.trim())) {
          const result = await agent.llmConfig.updateProvider({ id: saved.id, name: name.trim(), api_base_url: url.href,
            ...(key.trim() ? { api_key: key.trim() } : {}) });
          if (!result.success) throw new Error(result.message || 'images.api.saveFailed');
        }
        if (!saved) {
          const result = await agent.llmConfig.addProvider({ name: name.trim(), api_base_url: url.href,
            api_key: key.trim(), apiFormat: 'openai', category: 'other', enabled: true, models: [] });
          if (!result.success || !result.provider) throw new Error(result.message || 'images.api.saveFailed');
          createdSource.current = { id: result.provider.id, name: name.trim(), baseUrl: url.href };
        } else {
          createdSource.current = { ...saved, name: name.trim(), baseUrl: url.href };
        }
        setKey('');
        next = { ...next, providers: { ...next.providers,
          [instanceId]: { ...next.providers![instanceId]!, sourceProviderId: createdSource.current!.id } } };
        await onCredentialsChanged();
      } else if (!sources.some((source) => source.id === sourceId)) {
        throw new Error('images.provider.missingCredentials');
      }
      await onUpdate(next);
      onSaved(instanceId);
    } catch (err) {
      setError(err instanceof Error ? t(err.message) : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="space-y-5" data-testid="image-provider-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-xs">{t('images.api.instanceId')}
          <Input aria-label={t('images.api.instanceId')} value={id} disabled={disabled || Boolean(existingId)} onChange={(event) => setId(event.target.value)} />
        </label>
        <label className="space-y-1.5 text-xs">{t('images.api.protocol')}
          <Select value={protocol} disabled={disabled} options={IMAGE_PROVIDER_TEMPLATES.map((value) => ({ value: value.protocol, label: value.name }))}
            onChange={(value) => { setProtocol(value as ImageApiProtocol); }} />
        </label>
      </div>
      <div className="space-y-3 border-t border-border/60 pt-4">
        <label className="block space-y-1.5 text-xs">{t('images.api.source')}
          <Select value={credentialMode} disabled={disabled} onChange={setCredentialMode} options={[
            { value: 'new', label: t('images.api.newCredentials') },
            { value: 'saved', label: t('images.api.selectSource') },
          ]} />
        </label>
        {credentialMode === 'new' ? (
          <div className="space-y-3">
            <label className="block space-y-1.5 text-xs">{t('images.api.credentialName')}
              <Input aria-label={t('images.api.credentialName')} value={name} disabled={disabled} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="block space-y-1.5 text-xs">{t('images.api.baseUrl')}
              <Input aria-label={t('images.api.baseUrl')} value={baseUrl} disabled={disabled} placeholder={template.baseUrl || 'https://images.example.com/v1'} onChange={(event) => setBaseUrl(event.target.value)} />
            </label>
            <label className="block space-y-1.5 text-xs">{t('images.api.apiKey')}
              <Input aria-label={t('images.api.apiKey')} type="password" autoComplete="new-password" value={key} disabled={disabled}
                placeholder={createdSource.current ? t('images.api.keepKey') : ''} onChange={(event) => setKey(event.target.value)} />
            </label>
          </div>
        ) : (
          <div data-testid="image-credential-source"><Select value={sourceId} disabled={disabled} options={[
            { value: '', label: t('images.api.selectSource') },
            ...(!sources.some((source) => source.id === sourceId) && sourceId ? [{ value: sourceId, label: t('images.provider.missingCredentials') }] : []),
            ...sources.map((source) => ({ value: source.id, label: source.name || source.id })),
          ]} onChange={setSourceId} /></div>
        )}
      </div>
      <label className="flex items-center gap-2 text-xs"><Switch checked={enabled} disabled={disabled} onCheckedChange={setEnabled} />{t('images.track.on')}</label>
      <p className="text-xs text-muted-foreground">{t('images.models.afterCreate')}</p>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={disabled || !id.trim()
          || (credentialMode === 'new' ? !name.trim() || !baseUrl.trim() || (!key.trim() && !createdSource.current) : !sourceId)}>{t('images.api.save')}</Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onCancel}>{t('images.api.cancel')}</Button>
      </div>
    </form>
  );
}
