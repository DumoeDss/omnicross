/**
 * EndpointRoutingCard.tsx — per-endpoint routing config for one of the four
 * endpoints (`chat | responses | messages | gemini`). The editor is CLASS-AWARE
 * (model-kind-mapping):
 *  - kind-mapped (`messages`/`responses`): one model picker PER declared model
 *    KIND (messages: fable/opus/sonnet/haiku; responses: codex/mini), each
 *    writing `modelMap[kind]`. A blank required kind is flagged inline ("service
 *    can't start until it is mapped").
 *  - role-based (`chat`/`gemini`): a `defaultModel` + `backgroundModel` picker
 *    plus the `backgroundModelIds` override.
 *
 * The legacy vision picker is REMOVED. Model pickers are populated from the
 * daemon provider list, encoded as `"providerId,modelId"` refs.
 *
 * `useSubscription` is ENABLED only for `messages` + `responses`; for `chat` +
 * `gemini` it is DISABLED with a plain hint (mirrors the daemon's own
 * `subscriptionSupport` gating — a daemon semantic, not a missing feature).
 */

import React, { useMemo } from 'react';

import { Input } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';

import { ENDPOINT_MODEL_KINDS, isKindMappedEndpoint } from './endpointKinds';

import type { ModelRefOption } from './hooks/useApiService';
import type { EndpointRoutingConfig } from '@/daemon/types';

interface EndpointRoutingCardProps {
  endpoint: EndpointRoutingConfig;
  modelOptions: ModelRefOption[];
  busy: boolean;
  onChange: (next: EndpointRoutingConfig) => void;
}

/** `messages`/`responses` support subscription routing; `chat`/`gemini` do not. */
function subscriptionSupported(endpoint: string): boolean {
  return endpoint === 'messages' || endpoint === 'responses';
}

export function EndpointRoutingCard({ endpoint, modelOptions, busy, onChange }: EndpointRoutingCardProps) {
  const t = useTranslation();
  const endpointId = endpoint.endpoint;
  const subSupported = subscriptionSupported(endpointId);

  // Required-model pickers (no empty option — the daemon requires a value, but
  // we surface a placeholder when the stored ref is blank).
  const requiredOptions = useMemo<SelectOption[]>(
    () => modelOptions.map((o) => ({ value: o.value, label: o.label })),
    [modelOptions],
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
          {t(`apiService.endpoint.name.${endpointId}`)}
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

      {isKindMappedEndpoint(endpointId) ? (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t('apiService.endpoint.kindMapLabel')}
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            {ENDPOINT_MODEL_KINDS[endpointId].map((kind) => {
              const value = endpoint.modelMap?.[kind] ?? '';
              const missing = value.trim().length === 0;
              return (
                <div key={kind} className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    {t(`apiService.endpoint.kind.${kind}`)}
                  </label>
                  <Select
                    value={value}
                    options={requiredOptions}
                    placeholder={t('apiService.endpoint.modelPlaceholder')}
                    disabled={busy}
                    onChange={(next) =>
                      onChange({ ...endpoint, modelMap: { ...endpoint.modelMap, [kind]: next } })
                    }
                    size="sm"
                  />
                  {missing ? (
                    <p className="text-[11px] text-destructive">{t('apiService.endpoint.missingKind')}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('apiService.endpoint.defaultModel')}
            </label>
            <Select
              value={endpoint.defaultModel ?? ''}
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
              value={endpoint.backgroundModel ?? ''}
              options={requiredOptions}
              placeholder={t('apiService.endpoint.modelPlaceholder')}
              disabled={busy}
              onChange={(value) => onChange({ ...endpoint, backgroundModel: value })}
              size="sm"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
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
      )}
    </div>
  );
}
