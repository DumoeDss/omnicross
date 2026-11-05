import { HardDrive } from 'lucide-react';
import React, { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { ImagesServerConfig } from '@/daemon/types';
import { useTranslation } from '@/shared/state/LocaleContext';

/** Matches the daemon's admin GET sentinel for configured-but-masked secrets. */
const SECRET_SET = '__SET__';

type StorageConfig = NonNullable<ImagesServerConfig['storage']>;

const DEFAULT_STORAGE: StorageConfig = {
  enabled: false,
  kind: 's3',
  bucket: '',
  urlMode: 'signed',
  expiresInSeconds: 3600,
  forcePathStyle: true,
  accessKeyId: '',
  secretAccessKey: '',
};

function isSecretSet(value: string | undefined): boolean {
  return value === SECRET_SET;
}

export function ObjectStorageSection({ config, busy, onUpdate }: {
  config: ImagesServerConfig;
  busy: boolean;
  onUpdate: (config: ImagesServerConfig) => Promise<void>;
}) {
  const t = useTranslation();
  const stored = config.storage ?? DEFAULT_STORAGE;
  const [draft, setDraft] = useState<StorageConfig>(stored);
  const [accessKeyId, setAccessKeyId] = useState(isSecretSet(stored.accessKeyId) ? '' : stored.accessKeyId);
  const [secretAccessKey, setSecretAccessKey] = useState(
    isSecretSet(stored.secretAccessKey) ? '' : stored.secretAccessKey
  );
  const [sessionToken, setSessionToken] = useState(
    isSecretSet(stored.sessionToken) ? '' : stored.sessionToken ?? ''
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = busy || saving;

  const kindOptions: SelectOption[] = [
    { value: 's3', label: t('images.publishing.kindS3') },
    { value: 'oss', label: t('images.publishing.kindOss') },
  ];
  const urlModeOptions: SelectOption[] = [
    { value: 'signed', label: t('images.publishing.urlSigned') },
    { value: 'public', label: t('images.publishing.urlPublic') },
  ];

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Untouched masked secrets ride the sentinel so the daemon preserves the
      // stored values; an empty non-sentinel field is sent as-is (clears).
      const storage: StorageConfig = {
        ...draft,
        accessKeyId: accessKeyId || (isSecretSet(stored.accessKeyId) ? SECRET_SET : ''),
        secretAccessKey: secretAccessKey || (isSecretSet(stored.secretAccessKey) ? SECRET_SET : ''),
        sessionToken: sessionToken || (isSecretSet(stored.sessionToken) ? SECRET_SET : ''),
      };
      if (!storage.sessionToken) delete storage.sessionToken;
      await onUpdate({ ...config, storage });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-5 rounded-xl border border-border/70 bg-surface-1/50 p-5" data-testid="images-object-storage">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <HardDrive className="h-4 w-4 text-primary" aria-hidden="true" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('images.publishing.title')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t('images.publishing.description')}</p>
          </div>
        </div>
        <Switch
          checked={draft.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
          aria-label={t('images.enable')}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label htmlFor="object-storage-kind" className="space-y-1.5 text-xs">
          <span className="font-medium">{t('images.publishing.kind')}</span>
          <Select
            id="object-storage-kind"
            value={draft.kind}
            options={kindOptions}
            disabled={disabled}
            onChange={(kind) => setDraft({ ...draft, kind: kind as StorageConfig['kind'] })}
          />
        </label>
        <label htmlFor="object-storage-bucket" className="space-y-1.5 text-xs">
          <span className="font-medium">{t('images.publishing.bucket')}</span>
          <Input
            id="object-storage-bucket"
            value={draft.bucket}
            onChange={(event) => setDraft({ ...draft, bucket: event.target.value })}
            disabled={disabled}
            placeholder="my-bucket"
          />
        </label>
        <label htmlFor="object-storage-region" className="space-y-1.5 text-xs">
          <span className="font-medium">{t('images.publishing.region')}</span>
          <Input
            id="object-storage-region"
            value={draft.region ?? ''}
            onChange={(event) => setDraft({ ...draft, region: event.target.value })}
            disabled={disabled}
            placeholder="auto"
          />
        </label>
        <label htmlFor="object-storage-endpoint" className="space-y-1.5 text-xs">
          <span className="font-medium">{t('images.publishing.endpoint')}</span>
          <Input
            id="object-storage-endpoint"
            value={draft.endpoint ?? ''}
            onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
            disabled={disabled}
            placeholder="https://account.r2.cloudflarestorage.com"
          />
        </label>
        <label htmlFor="object-storage-prefix" className="space-y-1.5 text-xs">
          <span className="font-medium">{t('images.publishing.prefix')}</span>
          <Input
            id="object-storage-prefix"
            value={draft.prefix ?? ''}
            onChange={(event) => setDraft({ ...draft, prefix: event.target.value })}
            disabled={disabled}
            placeholder="omnicross"
          />
        </label>
        <label htmlFor="object-storage-url-mode" className="space-y-1.5 text-xs">
          <span className="font-medium">{t('images.publishing.urlMode')}</span>
          <Select
            id="object-storage-url-mode"
            value={draft.urlMode}
            options={urlModeOptions}
            disabled={disabled}
            onChange={(urlMode) => setDraft({ ...draft, urlMode: urlMode as StorageConfig['urlMode'] })}
          />
        </label>
        {draft.urlMode === 'public' ? (
          <label htmlFor="object-storage-public-base" className="space-y-1.5 text-xs">
            <span className="font-medium">{t('images.publishing.publicBaseUrl')}</span>
            <Input
              id="object-storage-public-base"
              value={draft.publicBaseUrl ?? ''}
              onChange={(event) => setDraft({ ...draft, publicBaseUrl: event.target.value })}
              disabled={disabled}
              placeholder="https://cdn.example.com"
            />
          </label>
        ) : (
          <label htmlFor="object-storage-expires" className="space-y-1.5 text-xs">
            <span className="font-medium">{t('images.publishing.expires')}</span>
            <Input
              id="object-storage-expires"
              type="number"
              min={1}
              max={604800}
              value={draft.expiresInSeconds}
              onChange={(event) =>
                setDraft({ ...draft, expiresInSeconds: Number(event.target.value) || 3600 })
              }
              disabled={disabled}
            />
          </label>
        )}
        <label htmlFor="object-storage-access-key" className="space-y-1.5 text-xs">
          <span className="font-medium">{t('images.publishing.accessKeyId')}</span>
          <Input
            id="object-storage-access-key"
            value={accessKeyId}
            onChange={(event) => setAccessKeyId(event.target.value)}
            disabled={disabled}
            placeholder={isSecretSet(stored.accessKeyId) ? t('images.publishing.secretSet') : '$ACCESS_KEY_ID'}
          />
        </label>
        <label htmlFor="object-storage-secret-key" className="space-y-1.5 text-xs">
          <span className="font-medium">{t('images.publishing.secretAccessKey')}</span>
          <Input
            id="object-storage-secret-key"
            type="password"
            autoComplete="new-password"
            value={secretAccessKey}
            onChange={(event) => setSecretAccessKey(event.target.value)}
            disabled={disabled}
            placeholder={isSecretSet(stored.secretAccessKey) ? t('images.publishing.secretSet') : '$SECRET_ACCESS_KEY'}
          />
        </label>
        <label htmlFor="object-storage-session-token" className="space-y-1.5 text-xs">
          <span className="font-medium">{t('images.publishing.sessionToken')}</span>
          <Input
            id="object-storage-session-token"
            type="password"
            autoComplete="new-password"
            value={sessionToken}
            onChange={(event) => setSessionToken(event.target.value)}
            disabled={disabled}
            placeholder={isSecretSet(stored.sessionToken) ? t('images.publishing.secretSet') : t('images.publishing.optional')}
          />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-lg bg-surface-0/80 px-3 py-2.5 text-xs">
          <span className="font-medium">{t('images.publishing.forcePathStyle')}</span>
          <Switch
            checked={draft.forcePathStyle}
            disabled={disabled}
            onCheckedChange={(forcePathStyle) => setDraft({ ...draft, forcePathStyle })}
            aria-label={t('images.publishing.forcePathStyle')}
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="images-object-storage-hint">
        {t('images.publishing.hint')}
      </p>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="button" size="sm" disabled={disabled} onClick={() => void save()}>
        {t('images.api.save')}
      </Button>
    </section>
  );
}
