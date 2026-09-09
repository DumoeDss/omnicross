/**
 * ProviderStatusCards — one status card per routed provider
 * (images-settings-tab D2): the provider's fresh-evidence-affirmed models,
 * availability with a safe reason, evidence age, and the honest
 * bootstrap-unverified label for the antigravity provider's v1 evidence.
 */

import { ShieldAlert, ShieldCheck } from 'lucide-react';
import React from 'react';

import { Badge } from '@/components/ui/badge';
import { useTranslation } from '@/shared/state/LocaleContext';

import { providerCardRows, type ProviderCardModel } from './providerCardModel';
import type { ImagesCapabilityStatus } from '@/daemon/types';

function ProviderCard({ row }: { row: ProviderCardModel }) {
  const t = useTranslation();
  return (
    <div className="rounded-lg border border-border/60 bg-surface-0/70 p-3" data-testid={`image-provider-${row.providerId}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-foreground">{row.label}</span>
        <span className="flex items-center gap-1.5">
          {row.unverified ? (
            <Badge variant="outline">{t('images.providers.bootstrap')}</Badge>
          ) : null}
          <Badge variant={row.available ? 'success' : 'secondary'}>
            {row.available
              ? t('images.providers.healthy')
              : t('images.providers.unhealthy')}
          </Badge>
        </span>
      </div>
      <div className="mt-2 flex items-start gap-1.5 text-[11px]">
        {row.available
          ? <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
          : <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />}
        <span className="text-muted-foreground">
          {row.available
            ? (row.evidenceAgeSeconds !== undefined
                ? t('images.providers.evidence', { age: row.evidenceAgeSeconds })
                : t('images.providers.noEvidence'))
            : (row.reason ?? t('images.track.unknown'))}
        </span>
      </div>
      {row.models.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {row.models.map((model) => (
            <li key={model}>
              <code className="rounded bg-surface-2/60 px-1.5 py-0.5 text-[10px]">{model}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[10px] text-muted-foreground">{t('images.providers.noModels')}</p>
      )}
    </div>
  );
}

export function ProviderStatusCards({
  capability,
}: {
  capability: ImagesCapabilityStatus | null;
}) {
  const rows = providerCardRows(capability);
  if (rows.length === 0) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {rows.map((row) => (
        <ProviderCard key={row.providerId} row={row} />
      ))}
    </div>
  );
}
