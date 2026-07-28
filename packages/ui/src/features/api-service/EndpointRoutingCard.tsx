/**
 * EndpointRoutingCard.tsx — per-endpoint routing config for one of the four
 * endpoints (`chat | responses | messages | gemini`). The editor is CLASS-AWARE
 * (model-kind-mapping) AND MODE-AWARE (provider/subscription duality):
 *
 *  - kind-mapped (`messages`/`responses`): one model picker PER declared model
 *    KIND (messages: fable/opus/sonnet/haiku; responses: codex/mini). In
 *    **Provider mode** (`useSubscription=false`) the pickers draw from the BYO
 *    daemon provider list; in **Subscription mode** (`useSubscription=true`)
 *    they draw from the chosen subscription provider's static model catalog
 *    (`SUBSCRIPTION_MODEL_CATALOG`) — which is how a `messages` endpoint can
 *    route to a Codex subscription (cross-protocol: Anthropic ingress ↔
 *    Responses upstream, converted by the serving engine).
 *  - list-mapped (`chat`): a MODEL LIST editor (BYO only — `chat` subscription
 *    is gated off here, mirroring the daemon's `subscriptionSupport`).
 *  - role-based (`gemini`): a `defaultModel` + `backgroundModel` picker.
 *
 * Subscription mode adds a subscription-provider picker (codex/claude/…) and an
 * account picker (pool vs a specific bound account via `boundAccountId`).
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
import { SUBSCRIPTION_MODEL_CATALOG, subscriptionProviderHasCatalog } from './subscriptionModelCatalog';

import type { ModelRefOption } from './hooks/useApiService';
import type {
  AccountsListResponse,
  EndpointRoutingConfig,
  ModelRef,
  SubscriptionProviderId,
} from '@/daemon/types';

interface EndpointRoutingCardProps {
  endpoint: EndpointRoutingConfig;
  modelOptions: ModelRefOption[];
  /** Subscription accounts (per-provider) for the subscription-mode account picker. */
  accounts: AccountsListResponse;
  busy: boolean;
  onChange: (next: EndpointRoutingConfig) => void;
}

/** `messages`/`responses` support subscription routing; `chat`/`gemini` do not. */
function subscriptionSupported(endpoint: string): boolean {
  return endpoint === 'messages' || endpoint === 'responses';
}

/** Subscription providers that expose a model catalog (pickable in subscription mode). */
const SUBSCRIPTION_PROVIDER_OPTIONS: SubscriptionProviderId[] = (
  Object.keys(SUBSCRIPTION_MODEL_CATALOG) as SubscriptionProviderId[]
).filter((p) => subscriptionProviderHasCatalog(p));

/** A subscription account's display label (falls back to a short id suffix). */
function accountLabel(a: { id: string; label?: string }, fallbackIndex: number): string {
  if (a.label && a.label.trim() !== '') return a.label;
  return `#${fallbackIndex + 1} ${a.id.slice(0, 8)}`;
}

/**
 * A sensible default model from a subscription catalog for one model KIND — used
 * to prefill the modelMap when the operator switches subscription provider, so
 * the kind pickers start populated (and `currentSubProvider` stays inferred as
 * the new provider). Name-match first (claude: `opus`→`claude-opus-5`), else a
 * size-tier fallback (codex: haiku→luna, sonnet→terra, opus/fable→sol).
 */
function defaultModelForKind(provider: SubscriptionProviderId, kind: string): string {
  const catalog = SUBSCRIPTION_MODEL_CATALOG[provider];
  if (catalog.length === 0) return '';
  const byName = catalog.find((m) => m.includes(kind));
  if (byName) return byName;
  const tier: Record<string, number> = { haiku: 0, mini: 0, sonnet: 1, codex: 2, opus: 2, fable: 2 };
  const idx = Math.min(tier[kind] ?? catalog.length - 1, catalog.length - 1);
  return catalog[idx];
}

export function EndpointRoutingCard({
  endpoint,
  modelOptions,
  accounts,
  busy,
  onChange,
}: EndpointRoutingCardProps) {
  const t = useTranslation();
  const endpointId = endpoint.endpoint;
  const subSupported = subscriptionSupported(endpointId);
  const kindMapped = isKindMappedEndpoint(endpointId);

  // Required-model pickers (no empty option — the daemon requires a value, but
  // we surface a placeholder when the stored ref is blank).
  const requiredOptions = useMemo<SelectOption[]>(
    () => modelOptions.map((o) => ({ value: o.value, label: o.label })),
    [modelOptions],
  );

  // ── Subscription-mode derived state (kind-mapped endpoints only) ──────────
  /** The current subscription provider, inferred from the first non-blank ref. */
  const currentSubProvider = useMemo<string>(() => {
    if (endpointId !== 'messages' && endpointId !== 'responses') return '';
    const map = endpoint.modelMap ?? {};
    for (const kind of ENDPOINT_MODEL_KINDS[endpointId]) {
      const ref = map[kind];
      if (typeof ref === 'string' && ref.includes(',')) {
        // Only a SUBSCRIPTION provider id counts — Provider-mode BYO refs
        // (e.g. "openai,…") must NOT become the subscription provider.
        const pid = ref.slice(0, ref.indexOf(','));
        if (pid in SUBSCRIPTION_MODEL_CATALOG) return pid;
      }
    }
    return '';
  }, [endpoint.modelMap, endpointId]);

  /** Per-kind model options for the CURRENT subscription provider's catalog. */
  const subModelOptions = useMemo<SelectOption[]>(() => {
    if (!currentSubProvider) return [];
    const catalog = SUBSCRIPTION_MODEL_CATALOG[currentSubProvider as SubscriptionProviderId] ?? [];
    return catalog.map((m) => ({
      value: `${currentSubProvider},${m}`,
      label: `${currentSubProvider} / ${m}`,
    }));
  }, [currentSubProvider]);

  /** Account options: the pool (auto-schedule) + each bound account of this provider. */
  const accountOptions = useMemo<SelectOption[]>(() => {
    if (!currentSubProvider) return [];
    const list = accounts.providerAccounts[currentSubProvider as SubscriptionProviderId] ?? [];
    return [
      { value: '', label: t('apiService.endpoint.accountPool') },
      ...list.map((a, i) => ({ value: a.id, label: accountLabel(a, i) })),
    ];
  }, [currentSubProvider, accounts, t]);

  /** Switch provider/subscription mode: clear incompatible refs + the other mode's binding. */
  const onModeChange = (checked: boolean) => {
    const next: EndpointRoutingConfig = { ...endpoint, useSubscription: checked };
    if (kindMapped) {
      // BYO refs and subscription refs are not interchangeable — reset the map.
      const modelMap: Record<string, ModelRef> = {};
      for (const kind of ENDPOINT_MODEL_KINDS[endpointId as 'messages' | 'responses']) {
        modelMap[kind] = '';
      }
      next.modelMap = modelMap;
    }
    if (checked) next.boundKeyId = undefined;
    else next.boundAccountId = undefined;
    onChange(next);
  };

  /** Switch subscription provider: prefill each kind with a sensible default for
   *  the NEW provider (so pickers start populated + `currentSubProvider` stays
   *  inferred as `next`), and reset the account binding. */
  const onSubProviderChange = (next: string) => {
    if (!next || next === currentSubProvider) return;
    const modelMap: Record<string, ModelRef> = {};
    for (const kind of ENDPOINT_MODEL_KINDS[endpointId as 'messages' | 'responses']) {
      const dm = defaultModelForKind(next as SubscriptionProviderId, kind);
      modelMap[kind] = dm ? `${next},${dm}` : '';
    }
    onChange({ ...endpoint, modelMap, boundAccountId: undefined });
  };

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
            onCheckedChange={onModeChange}
            aria-label={t('apiService.endpoint.useSubscription')}
          />
        </div>
      </div>

      {!subSupported ? (
        <p className="text-xs text-muted-foreground">{t('apiService.endpoint.subscriptionUnsupported')}</p>
      ) : null}

      {endpointId === 'chat' ? (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t('apiService.endpoint.modelListLabel')}
          </label>
          {(endpoint.models ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('apiService.endpoint.modelListEmpty')}</p>
          ) : (
            <ul className="space-y-1">
              {(endpoint.models ?? []).map((ref) => (
                <li key={ref} className="flex items-center justify-between gap-2 rounded border border-border/50 px-2 py-1">
                  <span className="text-xs text-foreground truncate">
                    {requiredOptions.find((o) => o.value === ref)?.label ?? ref}
                  </span>
                  <button
                    type="button"
                    className="text-[11px] text-muted-foreground hover:text-destructive shrink-0"
                    disabled={busy}
                    onClick={() =>
                      onChange({ ...endpoint, models: (endpoint.models ?? []).filter((m) => m !== ref) })
                    }
                  >
                    {t('apiService.endpoint.removeModel')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Select
            value=""
            options={requiredOptions.filter((o) => !(endpoint.models ?? []).includes(o.value))}
            placeholder={t('apiService.endpoint.addModelPlaceholder')}
            disabled={busy}
            onChange={(ref) => {
              if (!ref || (endpoint.models ?? []).includes(ref)) return;
              onChange({ ...endpoint, models: [...(endpoint.models ?? []), ref] });
            }}
            size="sm"
          />
        </div>
      ) : kindMapped ? (
        endpoint.useSubscription ? (
          // ── Subscription mode (kind-mapped): provider + account + modelMap ──
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  {t('apiService.endpoint.subscriptionType')}
                </label>
                <Select
                  value={currentSubProvider}
                  options={SUBSCRIPTION_PROVIDER_OPTIONS.map((p) => ({ value: p, label: p }))}
                  placeholder={t('apiService.endpoint.subscriptionTypePlaceholder')}
                  disabled={busy}
                  onChange={onSubProviderChange}
                  size="sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  {t('apiService.endpoint.account')}
                </label>
                <Select
                  value={endpoint.boundAccountId ?? ''}
                  options={accountOptions}
                  placeholder={t('apiService.endpoint.accountPool')}
                  disabled={busy || !currentSubProvider}
                  onChange={(id) => onChange({ ...endpoint, boundAccountId: id || undefined })}
                  size="sm"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                {t('apiService.endpoint.kindMapLabel')}
              </label>
              {currentSubProvider ? (
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
                          options={subModelOptions}
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
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t('apiService.endpoint.pickSubscriptionTypeFirst')}
                </p>
              )}
            </div>
          </div>
        ) : (
          // ── Provider mode (kind-mapped): BYO model per kind (unchanged) ──────
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
        )
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
