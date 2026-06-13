/**
 * StatusBadge.tsx — token-status indicator (icon + colored label).
 *
 * Maps a sanitized `TokenStatus` to an icon + semantic color + localized label
 * (`accounts.status.*`). Used in the per-provider card header and in each
 * multi-account row.
 */

import { AlertCircle, CheckCircle, Clock, XCircle, type LucideIcon } from 'lucide-react';
import React from 'react';

import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';

import type { TokenStatus } from '@/daemon/types';

interface StatusConfig {
  icon: LucideIcon;
  className: string;
  labelKey: string;
}

const STATUS_CONFIG: Record<TokenStatus, StatusConfig> = {
  unconfigured: { icon: XCircle, className: 'text-muted-foreground', labelKey: 'accounts.status.unconfigured' },
  authorized: { icon: CheckCircle, className: 'text-success', labelKey: 'accounts.status.authorized' },
  configured: { icon: CheckCircle, className: 'text-primary', labelKey: 'accounts.status.configured' },
  expired: { icon: Clock, className: 'text-warning', labelKey: 'accounts.status.expired' },
  error: { icon: AlertCircle, className: 'text-destructive', labelKey: 'accounts.status.error' },
};

interface StatusBadgeProps {
  status?: TokenStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const t = useTranslation();
  const { icon: Icon, className, labelKey } = STATUS_CONFIG[status ?? 'unconfigured'];
  return (
    <div className={cn('flex shrink-0 items-center gap-1.5 text-sm', className)}>
      <Icon className="h-4 w-4" aria-hidden="true" />
      <span>{t(labelKey)}</span>
    </div>
  );
}
