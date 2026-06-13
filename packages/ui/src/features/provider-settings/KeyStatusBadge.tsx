import { AlertCircle, Timer } from 'lucide-react';
import React from 'react';

import { useTranslation } from '@/shared/state/LocaleContext';

import type { ApiKeyEntry, KeyHealth } from '@shared/llm-config';

import {
  formatCountdown,
  resolveKeyStatus,
  resolveRelativeParts,
} from './apiKeyStatus';

interface KeyStatusBadgeProps {
  entry: ApiKeyEntry;
  health: KeyHealth | undefined;
  /** Current epoch-ms (bumped by the parent's 1s tick for live countdown). */
  now: number;
}

/**
 * Status badge shown next to a pool key's label. Colour + icon + text are kept
 * in lockstep (WCAG 1.4.1 — never colour alone). Healthy keys render a subtle
 * green dot to stay unobtrusive.
 */
export function KeyStatusBadge({ entry, health, now }: KeyStatusBadgeProps) {
  const t = useTranslation();
  const status = resolveKeyStatus(entry, health, now);

  if (status === 'cooling' && health) {
    const time = formatCountdown(health.until - now);
    const statusCode = health.lastStatus ?? entry.lastErrorStatus ?? null;
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning"
        title={statusCode ? String(statusCode) : undefined}
      >
        <Timer className="h-2.5 w-2.5" aria-hidden="true" />
        {t('providerSettings.apiKeyPool.statusCoolingDown', { time })}
        {statusCode ? <span className="opacity-80">· {statusCode}</span> : null}
      </span>
    );
  }

  if (status === 'authFailed') {
    const statusCode = entry.lastErrorStatus ?? null;
    const relative = entry.lastErrorAt
      ? resolveRelativeParts(entry.lastErrorAt, now)
      : null;
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-destructive/15 text-destructive">
        <AlertCircle className="h-2.5 w-2.5" aria-hidden="true" />
        {t('providerSettings.apiKeyPool.statusAuthFailed')}
        {statusCode ? <span className="opacity-80">· {statusCode}</span> : null}
        {relative ? (
          <span className="opacity-70">
            ·{' '}
            {t(`providerSettings.apiKeyPool.${relative.unitKey}`, {
              count: relative.value,
            })}
          </span>
        ) : null}
      </span>
    );
  }

  if (status === 'disabled') {
    return (
      <span className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground">
        {t('providerSettings.disabled')}
      </span>
    );
  }

  // healthy — subtle green dot, unobtrusive
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] text-success"
      title={t('providerSettings.apiKeyPool.statusHealthy')}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full bg-success"
        aria-hidden="true"
      />
      <span className="sr-only">
        {t('providerSettings.apiKeyPool.statusHealthy')}
      </span>
    </span>
  );
}
