import { Image as ImageIcon } from 'lucide-react';
import React, { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { ImagesServerConfig } from '@/daemon/types';
import { useTranslation } from '@/shared/state/LocaleContext';
import type { LLMProvider } from '@shared/llm-config';

import { ImageCredentialForm } from './ImageCredentialForm';
import { ImageProviderForm } from './ImageProviderForm';
import { ImageProviderModels } from './ImageProviderModels';
import { removeImageInstance } from './imageProviderConfigModel';
import { IMAGE_PROVIDER_TEMPLATES } from './imageProviderTemplates';

export function ImageProviderDetails({ id, config, sources, busy, onUpdate, onCredentialsChanged, onRemoved }: {
  id: string;
  config: ImagesServerConfig;
  sources: LLMProvider[];
  busy: boolean;
  onUpdate: (config: ImagesServerConfig) => Promise<void>;
  onCredentialsChanged: () => Promise<void>;
  onRemoved: () => void;
}) {
  const t = useTranslation();
  const [editing, setEditing] = useState(false);
  const [editingCredentials, setEditingCredentials] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = config.providers![id]!;
  const source = sources.find((value) => value.id === provider.sourceProviderId);
  const template = IMAGE_PROVIDER_TEMPLATES.find((value) => value.protocol === provider.protocol)!;
  async function remove() {
    try {
      setError(null);
      await onUpdate(removeImageInstance(config, id));
      onRemoved();
    } catch (err) { setError(err instanceof Error ? t(err.message) : String(err)); }
  }
  return (
    <section className="space-y-5" data-testid="image-provider-details">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10"><ImageIcon className="h-5 w-5 text-primary" /></span>
          <div><h2 className="text-lg font-semibold">{source?.name || id}</h2><p className="text-xs text-muted-foreground">{id} · {provider.protocol}</p></div>
          <Badge variant={provider.enabled === false || source?.enabled === false ? 'secondary' : 'default'}>{t(provider.enabled === false || source?.enabled === false ? 'images.track.off' : 'images.track.on')}</Badge>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>{t('images.api.edit')}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setRemoveOpen(true)}>{t('images.api.remove')}</Button>
        </div>
      </div>
      {editing ? (
        <ImageProviderForm config={config} sources={sources} template={template} existingId={id} busy={busy}
          onUpdate={onUpdate} onCredentialsChanged={onCredentialsChanged} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <div className="space-y-3 rounded-xl border border-border/70 bg-surface-1/50 p-4">
            <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{t('images.api.source')}</h3>
              <Button size="sm" variant="outline" disabled={busy || !source} onClick={() => setEditingCredentials(true)}>{t('images.api.editCredentials')}</Button>
            </div>
            <p className="text-sm">{source?.name || t('images.provider.missingCredentials')}</p>
            {editingCredentials && source ? <ImageCredentialForm source={source} onCancel={() => setEditingCredentials(false)} onSaved={async () => { await onCredentialsChanged(); setEditingCredentials(false); }} /> : null}
          </div>
          <ImageProviderModels key={JSON.stringify([provider, config.models])} id={id} config={config} busy={busy} onUpdate={onUpdate} />
        </>
      )}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <ConfirmDialog open={removeOpen} onOpenChange={setRemoveOpen} title={t('images.api.remove')}
        description={t('images.provider.removeDescription')} confirmLabel={t('images.api.remove')} cancelLabel={t('images.api.cancel')} onConfirm={() => void remove()} />
    </section>
  );
}
