/**
 * EndpointRoutingCard.tsx — per-endpoint routing config for one of the four
 * endpoints (`chat | responses | messages | gemini`). Edits `defaultModel`,
 * `backgroundModel`, `visionModel` (optional/clearable), `backgroundModelIds`,
 * and `useSubscription`.
 *
 * Model pickers are populated from the daemon provider list, encoded as
 * `"providerId,modelId"` refs (folding in the old "Default Models" concept).
 *
 * `useSubscription` is ENABLED only for `messages` + `responses`; for `chat` +
 * `gemini` it is DISABLED with a plain hint (this mirrors the daemon's own
 * `subscriptionSupport` gating — a daemon semantic, NOT a missing feature — so
 * it uses a plain `disabled` + hint, NOT the daemon-unbacked tooltip).
 */

import React, { useMemo } from 'react';

import { Input } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { ModelRefOption } from './hooks/useApiService';
import type { EndpointRoutingConfig } from '@/daemon/types';

interface EndpointRoutingCardProps {
  endpoint: EndpointRoutingConfig;
  modelOptions: ModelRefOption[];
  busy: boolean;
  onChange: (next: EndpointRoutingConfig) => void;
}

const NONE_VALUE = '__none__';

/** `messages`/`responses` support subscription routing; `chat`/`gemini` do not. */
function subscriptionSupported(endpoint: string): boolean {
  return endpoint === 'messages' || endpoint === 'responses';
}

export function EndpointRoutingCard({ endpoint, modelOptions, busy, onChange }: EndpointRoutingCardProps) {
  const t = useTranslation();
  const subSupported = subscriptionSupported(endpoint.endpoint);

  // Required-model pickers (no empty option — the daemon requires a value, but
  // we surface a placeholder when the stored ref is blank).
  const requiredOptions = useMemo<SelectOption[]>(
    () => modelOptions.map((o) => ({ value: o.value, label: o.label })),
    [modelOptions],
  );
  // Optional (vision) picker — prepend a "none" sentinel that clears the field.
  const optionalOptions = useMemo<SelectOption[]>(
    () => [{ value: NONE_VALUE, label: t('apiService.endpoint.noVisionModel') }, ...requiredOptions],
    [requiredOptions, t],
  );

  const backgroundIdsText = (endpoint.backgroundModelIds ?? []).join(', ');

  const onBackgroundIdsChange = (raw: string) => {
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    onChange({ ...endpoint, backgroundModelIds: ids });
  };

  return (
    <div className="rounded-md border border-border/60 bg-surface-0/60 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold uppercase tracking-wide text-foreground">
          {t(`apiService.endpoint.name.${endpoint.endpoint}`)}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t('apiService.endpoint.useSubscription')}</span>
          <Switch
            checked={subSupported ? endpoint.useSubscription : false}
            disabled={busy || !subSupported}
            onCheckedChange={(checked) => onChange({ ...endpoint, useSubscription: checked })}
            aria-label={t('apiService.endpoint.useSubscription')}
          />
        </div>
      </div>

      {!subSupported ? (
        <p className="text-xs text-muted-foreground">{t('apiService.endpoint.subscriptionUnsupported')}</p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t('apiService.endpoint.defaultModel')}
          </label>
          <Select
            value={endpoint.defaultModel}
            options={requiredOptions}
            placeholder={t('apiService.endpoint.modelPlaceholder')}
            disabled={busy}
            onChange={(value) => onChange({ ...endpoint, defaultModel: value })}
            size="sm"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t('apiService.endpoint.backgroundModel')}
          </label>
          <Select
            value={endpoint.backgroundModel}
            options={requiredOptions}
            placeholder={t('apiService.endpoint.modelPlaceholder')}
            disabled={busy}
            onChange={(value) => onChange({ ...endpoint, backgroundModel: value })}
            size="sm"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t('apiService.endpoint.visionModel')}
          </label>
          <Select
            value={endpoint.visionModel ? endpoint.visionModel : NONE_VALUE}
            options={optionalOptions}
            placeholder={t('apiService.endpoint.noVisionModel')}
            disabled={busy}
            onChange={(value) => {
              const next = { ...endpoint };
              if (value === NONE_VALUE) delete next.visionModel;
              else next.visionModel = value;
              onChange(next);
            }}
            size="sm"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t('apiService.endpoint.backgroundModelIds')}
          </label>
          <Input
            density="compact"
            value={backgroundIdsText}
            placeholder={t('apiService.endpoint.backgroundModelIdsPlaceholder')}
            disabled={busy}
            onChange={(e) => onBackgroundIdsChange(e.target.value)}
            onBlur={(e) => onBackgroundIdsChange(e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}
