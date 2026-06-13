/**
 * ServerStatusBanner.tsx — the live running/stopped + bound-port banner, driven
 * off `GET /status`. Shows the four format endpoint URLs (loopback always; LAN
 * when network binding is on, i.e. `status.lanFormats` is present).
 */

import { CircleDot, Copy, Power } from 'lucide-react';
import React, { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';

import type { OutboundApiServerStatus, OutboundFormatUrls } from '@/daemon/types';

interface ServerStatusBannerProps {
  status: OutboundApiServerStatus | null;
}

const FORMAT_KEYS: Array<keyof OutboundFormatUrls> = ['chat', 'responses', 'messages', 'gemini'];

function UrlRow({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-20 shrink-0 font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <code className="min-w-0 flex-1 truncate rounded bg-surface-2/60 px-2 py-1 text-foreground" title={url}>
        {url}
      </code>
      <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={copy} aria-label={label}>
        <Copy className={cn('h-3.5 w-3.5', copied && 'text-success')} />
      </Button>
    </div>
  );
}

function FormatList({ title, formats }: { title: string; formats: OutboundFormatUrls }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-semibold text-foreground">{title}</div>
      {FORMAT_KEYS.map((k) => (
        <UrlRow key={k} label={k} url={formats[k]} />
      ))}
    </div>
  );
}

export function ServerStatusBanner({ status }: ServerStatusBannerProps) {
  const t = useTranslation();
  const running = Boolean(status?.running);

  return (
    <div className="rounded-md border border-border/60 bg-surface-0/60 p-4 space-y-3">
      <div className="flex items-center gap-3">
        {running ? (
          <CircleDot className="h-5 w-5 shrink-0 text-success" aria-hidden="true" />
        ) : (
          <Power className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {running ? t('apiService.status.running') : t('apiService.status.stopped')}
            </span>
            {running && status?.port ? (
              <Badge variant="success">{t('apiService.status.port', { port: status.port })}</Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {running ? t('apiService.status.runningHint') : t('apiService.status.stoppedHint')}
          </p>
        </div>
      </div>

      {running && (status?.formats || status?.lanFormats) ? (
        <div className="grid gap-4 border-t border-border/50 pt-3 sm:grid-cols-2">
          {status?.formats ? (
            <FormatList title={t('apiService.status.loopback')} formats={status.formats} />
          ) : null}
          {status?.lanFormats ? (
            <FormatList title={t('apiService.status.lan')} formats={status.lanFormats} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
