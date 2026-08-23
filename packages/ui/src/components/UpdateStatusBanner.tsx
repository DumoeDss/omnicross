import { AlertTriangle, Download, Loader2, RefreshCw, Rocket } from 'lucide-react';
import React from 'react';

import { Button } from '@/components/ui/button';
import { updateActions } from '@/shared/state/updateModel';
import { useUpdateStatus } from '@/shared/state/useUpdateStatus';
import { useTranslation } from '@/shared/state/LocaleContext';
import { downloadUpdate, installUpdate } from '@/shared/tauri/update';
import { openExternal } from '@/shared/tauri/openExternal';

export function UpdateStatusBanner() {
  const t = useTranslation();
  const status = useUpdateStatus();
  const actions = updateActions(status);
  if (!status || !actions.showAppBanner) return null;

  const failure = status.state === 'failed';
  const busy = status.state === 'downloading';
  const ready = status.state === 'ready';
  const Icon = failure ? AlertTriangle : busy ? Loader2 : ready ? Rocket : Download;
  const label = failure
    ? status.error?.message ?? t('updates.failed')
    : busy
      ? t('updates.downloading', { percent: Math.round(status.progressPercent ?? 0) })
      : ready
        ? t('updates.ready', { version: status.latestVersion ?? '' })
        : t('updates.available', { version: status.latestVersion ?? '' });

  return (
    <div className={`flex items-center gap-2 border-b px-4 py-2 text-xs ${failure ? 'border-destructive/40 bg-destructive/10' : 'border-primary/30 bg-primary/10'}`}>
      <Icon className={`h-4 w-4 shrink-0 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {actions.canDownload || actions.canRetry ? (
        <Button size="sm" variant="outline" onClick={() => void downloadUpdate()}>
          <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {actions.canRetry ? t('updates.retry') : t('updates.download')}
        </Button>
      ) : null}
      {actions.canInstall ? (
        <Button size="sm" onClick={() => void installUpdate()}>{t('updates.installRestart')}</Button>
      ) : null}
      {actions.canOpenRelease && status.releaseUrl ? (
        <Button size="sm" variant="ghost" onClick={() => void openExternal(status.releaseUrl!)}>{t('updates.releasePage')}</Button>
      ) : null}
    </div>
  );
}
