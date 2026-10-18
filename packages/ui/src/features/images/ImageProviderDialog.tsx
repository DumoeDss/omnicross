import { ArrowLeft, ImagePlus, Search, SlidersHorizontal } from 'lucide-react';
import React, { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { ImagesServerConfig } from '@/daemon/types';
import { useTranslation } from '@/shared/state/LocaleContext';
import type { LLMProvider } from '@shared/llm-config';

import { ImageProviderForm } from './ImageProviderForm';
import { CUSTOM_IMAGE_TEMPLATE, IMAGE_PROVIDER_TEMPLATES, type ImageProviderTemplate } from './imageProviderTemplates';

export function ImageProviderDialog({ config, sources, busy, onUpdate, onCredentialsChanged, onSaved, onClose }: {
  config: ImagesServerConfig;
  sources: LLMProvider[];
  busy: boolean;
  onUpdate: (config: ImagesServerConfig) => Promise<void>;
  onCredentialsChanged: () => Promise<void>;
  onSaved: (id: string) => void;
  onClose: () => void;
}) {
  const t = useTranslation();
  const [template, setTemplate] = useState<ImageProviderTemplate | null>(null);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const templates = IMAGE_PROVIDER_TEMPLATES.filter((value) => (value.name + ' ' + value.protocol + ' ' + value.models).toLocaleLowerCase().includes(needle));
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[88vh] !w-[min(94vw,56rem)] !max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('images.api.add')}</DialogTitle>
          <DialogDescription>{t('images.api.description')}</DialogDescription>
        </DialogHeader>
        {template ? (
          <div className="space-y-4">
            <Button size="sm" variant="ghost" onClick={() => setTemplate(null)}><ArrowLeft className="mr-1.5 h-4 w-4" />{t('accounts.addDialog.back')}</Button>
            <h3 className="text-sm font-semibold">{template.name || t('providerSettings.form.skipTemplates')}</h3>
            <ImageProviderForm config={config} sources={sources} template={template} busy={busy}
              onUpdate={onUpdate} onCredentialsChanged={onCredentialsChanged} onSaved={onSaved} onCancel={onClose} />
          </div>
        ) : (
          <div className="space-y-4" data-testid="image-provider-templates">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-48 flex-1">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <Input className="pl-9" aria-label={t('providerSettings.searchPlaceholder')} placeholder={t('providerSettings.searchPlaceholder')} value={query} onChange={(event) => setQuery(event.target.value)} />
              </div>
              <Button size="sm" variant="outline" onClick={() => setTemplate(CUSTOM_IMAGE_TEMPLATE)}><SlidersHorizontal className="mr-1.5 h-4 w-4" />{t('providerSettings.form.skipTemplates')}</Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {templates.map((value) => (
                <button key={value.id} type="button" data-image-template={value.id} onClick={() => setTemplate(value)}
                  className="rounded-lg border border-border bg-surface-1/50 p-4 text-left transition-colors hover:border-primary/50 hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="flex items-center gap-2 text-sm font-medium"><ImagePlus className="h-4 w-4 text-primary" aria-hidden="true" />{value.name}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{value.protocol}</span>
                  <span className="mt-2 block break-words text-xs text-muted-foreground">{value.models.split('\n').map((line) => line.split(' = ').pop()).join(', ')}</span>
                </button>
              ))}
            </div>
            {!templates.length ? <p className="py-8 text-center text-sm text-muted-foreground">{t('providerSettings.emptySearch')}</p> : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
