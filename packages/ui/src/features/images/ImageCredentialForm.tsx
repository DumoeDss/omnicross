import React, { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { LLMProvider } from '@shared/llm-config';
import { agent } from '@/shared/agent';
import { useTranslation } from '@/shared/state/LocaleContext';

function usesLegacyEndpoint(source?: LLMProvider): boolean {
  return Boolean(source?.codingPlan?.enabled && source.codingPlan.baseUrl
    && !source.apiModes?.some((mode) => mode.id === source.selectedApiModeId));
}

export function ImageCredentialForm({ source, onSaved, onCancel }: {
  source?: LLMProvider;
  onSaved: (id: string) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslation();
  const [name, setName] = useState(source?.name ?? '');
  const legacy = usesLegacyEndpoint(source);
  const [baseUrl, setBaseUrl] = useState((legacy ? source?.codingPlan?.baseUrl : source?.api_base_url) ?? '');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const url = new URL(baseUrl.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error(t('images.api.invalidUrl'));
      }
      const result = source
        ? await agent.llmConfig.updateProvider({ id: source.id, name: name.trim(),
          ...(legacy ? { codingPlan: { ...source.codingPlan!, baseUrl: url.href,
            ...(key.trim() ? { apiKey: key.trim() } : {}) } }
            : { api_base_url: url.href, ...(key.trim() ? { api_key: key.trim() } : {}) }) })
        : await agent.llmConfig.addProvider({ name: name.trim(), api_base_url: url.href,
          api_key: key.trim(), apiFormat: 'openai', category: 'other', enabled: true, models: [] });
      if (!result.success || !result.provider) throw new Error(result.message || t('images.api.saveFailed'));
      setKey('');
      await onSaved(result.provider.id);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-3 rounded-lg border border-border/70 p-3">
    <p className="text-xs text-muted-foreground">{t('images.api.credentialsHint')}</p>
    <label className="block space-y-1 text-xs">{t('images.api.credentialName')}
      <Input value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
    </label>
    <label className="block space-y-1 text-xs">{t('images.api.baseUrl')}
      <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} disabled={busy} placeholder="https://api.openai.com/v1" />
    </label>
    <label className="block space-y-1 text-xs">{t('images.api.apiKey')}
      <Input type="password" autoComplete="new-password" value={key} onChange={(event) => setKey(event.target.value)} disabled={busy}
        placeholder={source ? t('images.api.keepKey') : ''} />
    </label>
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    <div className="flex gap-2">
      <Button size="sm" disabled={busy || !name.trim() || !baseUrl.trim() || (!source && !key.trim())} onClick={() => void save()}>{t('images.api.save')}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>{t('images.api.cancel')}</Button>
    </div>
  </div>;
}
