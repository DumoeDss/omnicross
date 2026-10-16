import React, { useState } from 'react';

import { Button } from '@/components/ui/button';
import type { ImagesServerConfig } from '@/daemon/types';
import { useTranslation } from '@/shared/state/LocaleContext';
import { saveImageAliases } from './imageProviderConfigModel';

export function ImageAliasesForm({ config, busy, onUpdate }: {
  config: ImagesServerConfig; busy: boolean; onUpdate: (config: ImagesServerConfig) => Promise<void>;
}) {
  const t = useTranslation();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function save() {
    try {
      setError(null);
      await onUpdate(saveImageAliases(config, text));
      setEditing(false);
    } catch (err) { setError(err instanceof Error ? t(err.message) : String(err)); }
  }
  return <div className="space-y-2 border-t border-border/60 pt-3">
    <div className="flex items-center justify-between gap-2">
      <p className="text-xs font-medium">{t('images.api.aliases')}</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => {
        setText(Object.entries(config.aliases).map(([alias, target]) => `${alias} = ${target}`).join('\n'));
        setError(null); setEditing(true);
      }}>{t('images.api.edit')}</Button>
    </div>
    {editing ? <>
      <label className="block space-y-1 text-xs">{t('images.api.aliasesHint')}
        <textarea className="min-h-20 w-full rounded-md border border-border bg-surface-0 p-2 font-mono text-xs"
          value={text} onChange={(event) => setText(event.target.value)} disabled={busy} /></label>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void save()}>{t('images.api.save')}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(false)}>{t('images.api.cancel')}</Button>
      </div>
    </> : <p className="text-xs text-muted-foreground">{Object.entries(config.aliases).map(([alias, target]) => `${alias} → ${target}`).join(' · ') || '—'}</p>}
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
  </div>;
}
